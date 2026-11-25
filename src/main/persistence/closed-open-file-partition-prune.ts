import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import {
  pruneClosedOpenFileFromSlice,
  type ClosedOpenFilePruneArgs
} from '../../shared/workspace-session/closed-open-file-partition-prune'

export { pruneClosedOpenFileFromSlice } from '../../shared/workspace-session/closed-open-file-partition-prune'
export type { ClosedOpenFilePruneArgs } from '../../shared/workspace-session/closed-open-file-partition-prune'

/**
 * Read-and-remove runs inside one main-side call so concurrent closes cannot interleave reads
 * and writes: two closes overlapping in a renderer would otherwise each hold a stale snapshot
 * and the later write would restore the earlier prune (lost update).
 */
export function pruneClosedOpenFileAcrossPartitions(
  io: {
    hostIds: readonly string[]
    read: (hostId: string) => WorkspaceSessionState
    write: (slice: WorkspaceSessionState, hostId: string) => void
  },
  args: ClosedOpenFilePruneArgs
): void {
  // A refused local write (frozen store) must not leave the remote partitions' rows behind.
  const failures: unknown[] = []
  for (const hostId of io.hostIds) {
    try {
      const pruned = pruneClosedOpenFileFromSlice(io.read(hostId), args)
      if (pruned) {
        io.write(pruned, hostId)
      }
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw failures[0]
  }
}
