/** Crashes and older unlink flows can leave runtime session partitions that listings advertise as orphaned hosts. */
import { existsSync } from 'node:fs'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../shared/runtime-environment-store-file'

type SessionHostStore = {
  getWorkspaceSessionHostIds: () => ExecutionHostId[]
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

/** Drop orphaned runtime hosts while preserving local and SSH sessions. */
export function reconcileOrphanedRuntimeSessions(
  store: SessionHostStore,
  userDataPath: string
): ExecutionHostId[] {
  // Missing or unreadable registry data cannot prove a server was removed.
  if (!existsSync(getEnvironmentStorePath(userDataPath))) {
    return []
  }
  let known: Set<string>
  try {
    known = new Set(listEnvironments(userDataPath).map((environment) => environment.id))
  } catch (error) {
    console.warn('[runtime-environments] skipped orphaned session reconcile:', error)
    return []
  }
  // Runtime sessions are written only after their server is registered.
  const dropped = store.getWorkspaceSessionHostIds().filter((hostId) => {
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind === 'runtime' && !known.has(parsed.environmentId)
  })
  for (const hostId of dropped) {
    store.removeWorkspaceSessionHost(hostId)
  }
  return dropped
}
