/** Crashes and older unlink flows can leave runtime session partitions that listings advertise as orphaned hosts. */
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

type SessionHostStore = {
  getWorkspaceSessionHostIds: () => ExecutionHostId[]
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

/** Drop orphaned runtime hosts while preserving local and SSH sessions; `known` comes from
 *  readSavedRuntimeEnvironmentIds, and null (removal unproven) drops nothing. */
export function reconcileOrphanedRuntimeSessions(
  store: SessionHostStore,
  known: ReadonlySet<string> | null
): ExecutionHostId[] {
  if (!known) {
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
