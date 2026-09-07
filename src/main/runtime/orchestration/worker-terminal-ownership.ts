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
  endpoint_id: string | null
  endpoint_incarnation: string | null
  host_scope: string | null
  ownership_state: WorkerTerminalOwnershipState
  release_state: WorkerTerminalReleaseState
  retained_reason: string | null
  release_requested_at: string | null
  release_completed_at: string | null
  release_error: string | null
  recovery_attempt_count: number
  last_recovery_at: string | null
  archive_source: string | null
  archive_status: WorkerTerminalArchiveStatus | null
  created_at: string
  updated_at: string
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
  resource: Pick<WorkerTerminalResourceRow, 'ownership_state' | 'release_state'> | null
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

export type WorkerTerminalReleaseDecision =
  | { action: 'already_released' }
  | { action: 'retained'; reason: WorkerTerminalRetainedReason }
  | { action: 'proceed' }

// The single (ownership_state, release_state) -> action table. Both release guards read it, so a
// resource the dispatch no longer owns can never be settled as released down either path.
export function decideWorkerTerminalRelease(
  resource: Pick<WorkerTerminalResourceRow, 'ownership_state' | 'release_state' | 'retained_reason'>
): WorkerTerminalReleaseDecision {
  if (resource.release_state === 'released' || resource.ownership_state === 'released') {
    return { action: 'already_released' }
  }
  switch (resource.ownership_state) {
    case 'external':
      return {
        action: 'retained',
        reason: (resource.retained_reason as WorkerTerminalRetainedReason) ?? 'external_terminal'
      }
    case 'user_owned':
      return { action: 'retained', reason: 'user_takeover' }
    case 'transferred':
      return { action: 'retained', reason: 'ownership_transferred' }
    case 'owned':
      return { action: 'proceed' }
  }
}

/** SQL form of the table's `proceed` arm, for the compare-and-set race guard on the same row. */
export const WORKER_TERMINAL_RELEASABLE_ROW_SQL =
  "ownership_state = 'owned' AND release_state <> 'released'"
