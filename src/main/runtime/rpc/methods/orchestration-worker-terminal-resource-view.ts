import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'

/** Client-facing projection of a worker terminal resource row, without private columns. */
export function exposeWorkerTerminalResource(resource: WorkerTerminalResourceRow): {
  id: string
  ownershipState: string
  releaseState: string
  retainedReason: string | null
  terminalHandle: string
  worktreeId: string | null
  originDispatchId: string
  ownerDispatchId: string
  releaseRequestedAt: string | null
  releaseCompletedAt: string | null
  releaseError: string | null
  archive: { source: string | null; status: string | null }
} {
  return {
    id: resource.id,
    ownershipState: resource.ownership_state,
    releaseState: resource.release_state,
    retainedReason: resource.retained_reason,
    terminalHandle: resource.terminal_handle,
    worktreeId: resource.worktree_id,
    originDispatchId: resource.origin_dispatch_id,
    ownerDispatchId: resource.owner_dispatch_id,
    releaseRequestedAt: resource.release_requested_at,
    releaseCompletedAt: resource.release_completed_at,
    releaseError: resource.release_error,
    archive: { source: resource.archive_source, status: resource.archive_status }
  }
}

export function archiveSummary(
  resource: WorkerTerminalResourceRow | null
): { source: string | null; status: string | null } | null {
  if (!resource) {
    return null
  }
  if (!resource.archive_source && !resource.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}
