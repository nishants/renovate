import { readFile } from 'fs-extra';
import { join } from 'upath';
import { exec } from '../../../util/exec';
import { logger } from '../../../logger';
import { PostUpdateConfig, Upgrade } from '../../common';
import { SYSTEM_INSUFFICIENT_DISK_SPACE } from '../../../constants/error-messages';
import { DatasourceError } from '../../../datasource';
import { BinarySource } from '../../../util/exec/common';

export interface GenerateLockFileResult {
  error?: boolean;
  lockFile?: string;
  stderr?: string;
}

export async function generateLockFile(
  cwd: string,
  env?: NodeJS.ProcessEnv,
  config: PostUpdateConfig = {},
  upgrades: Upgrade[] = []
): Promise<GenerateLockFileResult> {
  logger.debug(`Spawning yarn install to create ${cwd}/yarn.lock`);
  let lockFile = null;
  let stdout = '';
  let stderr = '';
  let cmd = 'yarn';
  try {
    if (config.binarySource === BinarySource.Docker) {
      logger.debug('Running yarn via docker');
      cmd = `docker run --rm `;
      // istanbul ignore if
      if (config.dockerUser) {
        cmd += `--user=${config.dockerUser} `;
      }
      const volumes = [cwd];
      if (config.cacheDir) {
        volumes.push(config.cacheDir);
      }
      cmd += volumes.map(v => `-v "${v}":"${v}" `).join('');
      if (config.dockerMapDotfiles) {
        const homeDir =
          process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
        const homeNpmrc = join(homeDir, '.npmrc');
        cmd += `-v ${homeNpmrc}:/home/ubuntu/.npmrc `;
      }
      const envVars = ['NPM_CONFIG_CACHE', 'npm_config_store'];
      cmd += envVars.map(e => `-e ${e} `).join('');
      cmd += `-w "${cwd}" `;
      cmd += `renovate/yarn yarn`;
    }
    logger.debug(`Using yarn: ${cmd}`);
    let cmdExtras = '';
    cmdExtras += ' --ignore-scripts';
    cmdExtras += ' --ignore-engines';
    cmdExtras += ' --ignore-platform';
    cmdExtras += process.env.YARN_MUTEX_FILE
      ? ` --mutex file:${process.env.YARN_MUTEX_FILE}`
      : ' --mutex network:31879';
    const installCmd = cmd + ' install' + cmdExtras;
    // TODO: Switch to native util.promisify once using only node 8
    await exec(installCmd, {
      cwd,
      env,
    });
    const lockUpdates = upgrades
      .filter(upgrade => upgrade.isLockfileUpdate)
      .map(upgrade => upgrade.depName);
    if (lockUpdates.length) {
      logger.debug('Performing lockfileUpdate (yarn)');
      const updateCmd =
        cmd +
        ' upgrade' +
        lockUpdates.map(depName => ` ${depName}`).join('') +
        cmdExtras;
      const updateRes = await exec(updateCmd, {
        cwd,
        env,
      });
      stdout += updateRes.stdout
        ? /* istanbul ignore next */ updateRes.stdout
        : '';
      stderr += updateRes.stderr
        ? /* istanbul ignore next */ updateRes.stderr
        : '';
    }
    if (
      config.postUpdateOptions &&
      config.postUpdateOptions.includes('yarnDedupeFewer')
    ) {
      logger.debug('Performing yarn dedupe fewer');
      const dedupeCommand =
        'npx yarn-deduplicate@1.1.1 --strategy fewer && yarn';
      const dedupeRes = await exec(dedupeCommand, {
        cwd,
        env,
      });
      stdout += dedupeRes.stdout
        ? /* istanbul ignore next */ dedupeRes.stdout
        : '';
      stderr += dedupeRes.stderr
        ? /* istanbul ignore next */ dedupeRes.stderr
        : '';
    }
    if (
      config.postUpdateOptions &&
      config.postUpdateOptions.includes('yarnDedupeHighest')
    ) {
      logger.debug('Performing yarn dedupe highest');
      const dedupeCommand =
        'npx yarn-deduplicate@1.1.1 --strategy highest && yarn';
      const dedupeRes = await exec(dedupeCommand, {
        cwd,
        env,
      });
      stdout += dedupeRes.stdout
        ? /* istanbul ignore next */ dedupeRes.stdout
        : '';
      stderr += dedupeRes.stderr
        ? /* istanbul ignore next */ dedupeRes.stderr
        : '';
    }
    lockFile = await readFile(join(cwd, 'yarn.lock'), 'utf8');
  } catch (err) /* istanbul ignore next */ {
    logger.debug(
      {
        cmd,
        err,
        stdout,
        stderr,
        type: 'yarn',
      },
      'lock file error'
    );
    if (err.stderr) {
      if (err.stderr.includes('ENOSPC: no space left on device')) {
        throw new Error(SYSTEM_INSUFFICIENT_DISK_SPACE);
      }
      if (
        err.stderr.includes('The registry may be down.') ||
        err.stderr.includes('getaddrinfo ENOTFOUND registry.yarnpkg.com') ||
        err.stderr.includes('getaddrinfo ENOTFOUND registry.npmjs.org')
      ) {
        throw new DatasourceError(err);
      }
    }
    return { error: true, stderr: err.stderr };
  }
  return { lockFile };
}
