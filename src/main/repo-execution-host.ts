import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  type ExecutionHostId
} from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { requireReachableGitRoute } from './providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from './providers/ssh-host-not-served-error'

/** Only for rows from this process's Store: runtime stamps address files registered here. */
export function getStoredRepoExecutionHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const hostId = getRepoExecutionHostId(repo)
  return getSshTargetIdForExecutionHost(hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}

/** Store rows may carry runtime stamps for local files; connectionIds still require SSH. */
export function requireRepoLocalGitRoute(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ReturnType<typeof requireReachableGitRoute> {
  const route = requireReachableGitRoute(getStoredRepoExecutionHostId(repo))
  const staleConnectionId = normalizeHostPart(repo.connectionId)
  if (staleConnectionId) {
    throw new SshHostNotServedError(staleConnectionId)
  }
  return route
}
