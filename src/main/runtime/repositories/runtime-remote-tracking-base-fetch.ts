import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../../shared/git/fetch/git-fetch-auto-maintenance'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import type { GitExecOptions } from '../../git/command-runner/git-exec-options'
import { withRepositoryGitCause } from '../../git/repository-git-cause'
import type { RemoteTrackingBase } from './runtime-remote-fetch-controller'

export function runRemoteTrackingBaseFetch(
  repoPath: string,
  base: RemoteTrackingBase,
  gitOptions: Omit<GitExecOptions, 'cwd'>,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return withRepositoryGitCause(
    repoPath,
    gitOptions,
    { family: 'fetch', reason: 'base-refresh', cache: 'miss' },
    () =>
      gitExecFileAsync(
        [
          ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
          'fetch',
          '--no-tags',
          base.remote,
          `+refs/heads/${base.branch}:${base.ref}`
        ],
        { cwd: repoPath, ...gitOptions, useConfiguredSshCommandForNetwork: true, timeout }
      )
  )
}
