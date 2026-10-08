import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Store } from '../persistence'
import type { ActionsRequestContext } from '../../shared/github/actions-types'
import { assertRegisteredGitHubRepo } from './github-repo-routing'
/** Reject stale registrations, folder workspaces and runtime-owned repositories from the desktop IPC route. */
export function registeredActionsRepo(args: ActionsRequestContext, store: Store) {
  const repo = assertRegisteredGitHubRepo(args, store)
  if (
    isFolderRepo(repo) ||
    parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'runtime'
  ) {
    throw new Error('Actions must be requested on the registered Git repository execution host')
  }
  return repo
}
