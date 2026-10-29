/** Crashes and older unlink flows can leave runtime session partitions that listings advertise as orphaned hosts. */
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { readEnvironmentStoreRecords } from '../../../shared/runtime-environment-store-records'

type SessionHostStore = {
  getWorkspaceSessionHostIds: () => ExecutionHostId[]
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

/** Drop orphaned runtime hosts while preserving local and SSH sessions. */
export function reconcileOrphanedRuntimeSessions(
  store: SessionHostStore,
  userDataPath: string
): ExecutionHostId[] {
  let known: Set<string>
  try {
    // Raw records, not the listing: newer-format and overlay-hidden servers are still saved.
    const records = readEnvironmentStoreRecords(userDataPath, { requireStoreFile: true })
    if (records.unreadable.some((record) => record.id === undefined)) {
      return []
    }
    known = new Set([
      ...records.environments.map((environment) => environment.id),
      ...records.unreadable.map((record) => record.id ?? '')
    ])
  } catch {
    // Missing or unreadable registry data cannot prove a server was removed.
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
