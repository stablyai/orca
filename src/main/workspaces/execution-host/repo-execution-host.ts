import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'

export function bindRepoExecutionHost(
  repo: Pick<Repo, 'executionHostId' | 'connectionId'>,
  scope: 'native' | 'runtime-store'
): { executionHostId: ExecutionHostId; connectionId: string | null } | null {
  const legacyConnectionId = normalizeHostPart(repo.connectionId)
  const owner = parseRoutableExecutionHostId(
    normalizeHostPart(repo.executionHostId) ?? getConnectionExecutionHostId(legacyConnectionId)
  )
  if (!owner) {
    return null
  }
  if (owner.kind === 'runtime') {
    // A server's store-backed runtime stamp names its own files; nested SSH needs another transport.
    return scope === 'runtime-store' && !legacyConnectionId
      ? { executionHostId: LOCAL_EXECUTION_HOST_ID, connectionId: null }
      : null
  }
  const connectionId = owner.kind === 'ssh' ? owner.targetId : null
  if (legacyConnectionId && legacyConnectionId !== connectionId) {
    return null
  }
  return { executionHostId: owner.id, connectionId }
}

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
