import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import { structuralValuesEqual } from '../../shared/collections/structural-value-equality'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'
import { resolveHostId } from './loading-store/workspace-sessions/session-host-partitions'

type AppliedPatch = { patch: WorkspaceSessionPatch; partition: WorkspaceSessionState }

/**
 * Windows patch every host partition each round, though usually only one host's workspaces changed.
 * A patch equal to the last one applied to a partition nobody has replaced since would rebuild the
 * same partition, so it can be dropped before normalization and the write listeners.
 */
export class WindowSessionPatchRepeats {
  private readonly applied = new Map<ExecutionHostId, AppliedPatch>()

  constructor(private readonly readPartition: (hostId: ExecutionHostId) => WorkspaceSessionState) {}

  isRepeat(patch: WorkspaceSessionPatch, hostId: string | null | undefined): boolean {
    const resolved = resolveHostId(hostId)
    const last = this.applied.get(resolved)
    // Any other writer replaces the partition object, so its rows are never kept over this patch.
    return (
      last !== undefined &&
      last.partition === this.readPartition(resolved) &&
      structuralValuesEqual(last.patch, patch)
    )
  }

  /** Call only after the patch was written; a fenced or failed write must leave no record. */
  noteApplied(patch: WorkspaceSessionPatch, hostId: string | null | undefined): void {
    const resolved = resolveHostId(hostId)
    this.applied.set(resolved, { patch, partition: this.readPartition(resolved) })
  }
}
