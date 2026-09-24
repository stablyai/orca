import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type { GitExec } from '../git/repo-default-base-ref'
import { gitExecFileAsync } from '../git/runner'
import { getLocalProjectGitExecOptions } from '../project-runtime-git-options'
import { resolveGitRouteForHost } from '../providers/execution-host-provider-dispatch'
import type { Store } from '../persistence'

const WORKSPACE_STATUS_GIT_TIMEOUT_MS = 2_500

/**
 * Git for one repo's default-branch comparison.
 * `null` means this process cannot verify the host — never a cue to run the command locally.
 */
export function gitExecForWorkspaceStatus(store: Store, repo: Repo): GitExec | null {
  if (isFolderRepo(repo)) {
    return null
  }
  let route: ReturnType<typeof resolveGitRouteForHost>
  try {
    route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  } catch {
    return null
  }
  if (route.kind === 'runtime') {
    return null
  }
  if (route.kind === 'ssh') {
    if (!route.provider) {
      return null
    }
    const provider = route.provider
    return (argv) => provider.exec(argv, repo.path, { timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS })
  }
  let cwd = repo.path
  let wslDistro: string | undefined
  try {
    const options = getLocalProjectGitExecOptions(store, repo)
    cwd = options.cwd
    wslDistro = options.wslDistro
  } catch {
    return null
  }
  return (argv) =>
    gitExecFileAsync(argv, {
      cwd,
      timeout: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
      admissionTier: 'background',
      ...(wslDistro ? { wslDistro } : {})
    })
}
