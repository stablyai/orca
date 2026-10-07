import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'

/** Only for rows from this process's Store: runtime stamps address files registered here. */
export function getStoredRepoExecutionHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const hostId = getRepoExecutionHostId(repo)
  return getSshTargetIdForExecutionHost(hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}

export function getStoredRepoSshConnectionId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): string | null {
  return getSshTargetIdForExecutionHost(getStoredRepoExecutionHostId(repo))
}
