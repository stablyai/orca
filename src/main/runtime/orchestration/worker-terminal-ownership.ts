import type { WorkerDispatchState } from './types'

export type WorkerTerminalOwnershipState =
  | 'owned'
  | 'transferred'
  | 'user_owned'
  | 'external'
  | 'released'

export type WorkerTerminalReleaseState =
  | 'not_requested'
  | 'retained'
  | 'requested'
  | 'releasing'
  | 'released'
  | 'unknown'

export type WorkerTerminalRetainedReason =
  | 'external_terminal'
  | 'ownership_transferred'
  | 'user_takeover'
  | 'user_requested'
  | 'no_owned_resource'
  | 'identity_unproven'
  | 'legacy_ambiguous'
  | 'federation_unsupported'

export type WorkerTerminalArchiveStatus = 'captured' | 'empty' | 'unavailable'

export type WorkerTerminalResourceRow = {
  id: string
  origin_dispatch_id: string
  owner_dispatch_id: string
  prior_owner_dispatch_ids: string
  worktree_id: string | null
  terminal_handle: string
  pane_key: string | null
  process_incarnation: string | null
  host_scope: string | null
  ownership_state: WorkerTerminalOwnershipState
  release_state: WorkerTerminalReleaseState
  retained_reason: string | null
  release_requested_at: string | null
  release_completed_at: string | null
  release_error: string | null
  archive_source: string | null
  archive_status: WorkerTerminalArchiveStatus | null
  created_at: string
  updated_at: string
}

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

// Terminal state exposed by worker-list; process accounting, never Task/Dispatch outcome.
export type WorkerTerminalListState =
  | 'active'
  | 'reclaimable'
  | 'retained'
  | 'release_pending'
  | 'release_unknown'
  | 'released'

export type WorkerDispatchListState = WorkerDispatchState | 'unsupervised'

export type WorkerTerminalArchiveRow = {
  dispatch_id: string
  resource_id: string
  kind: 'transcript_pin' | 'terminal_tail'
  content: string
  created_at: string
}

export const WORKER_SETTLED_STATES: readonly WorkerDispatchState[] = [
  'succeeded',
  'failed',
  'stopped',
  'abandoned'
]

export const WORKER_RELEASABLE_STATES: readonly WorkerDispatchState[] = ['succeeded', 'failed']

// Process accounting for worker-list; deliberately independent of Task/Dispatch outcome.
export function deriveWorkerTerminalListState(params: {
  workerState: WorkerDispatchListState
  agentTerminalHandle: string | null
  resource: WorkerTerminalResourceRow | null
}): WorkerTerminalListState | null {
  const { resource } = params
  if (!resource) {
    return params.agentTerminalHandle ? 'retained' : null
  }
  if (resource.release_state === 'released') {
    return 'released'
  }
  if (resource.release_state === 'unknown') {
    return 'release_unknown'
  }
  if (resource.release_state === 'requested' || resource.release_state === 'releasing') {
    return 'release_pending'
  }
  if (resource.ownership_state !== 'owned' || resource.release_state === 'retained') {
    return 'retained'
  }
  if (
    params.workerState !== 'unsupervised' &&
    WORKER_RELEASABLE_STATES.includes(params.workerState)
  ) {
    return 'reclaimable'
  }
  return params.workerState !== 'unsupervised' && WORKER_SETTLED_STATES.includes(params.workerState)
    ? 'retained'
    : 'active'
}
