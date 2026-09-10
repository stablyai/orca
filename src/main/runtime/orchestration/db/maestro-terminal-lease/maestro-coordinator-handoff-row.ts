import type {
  MaestroCoordinatorHandoffReceipt,
  MaestroCoordinatorHandoffTerminalPhase
} from '../../../../../shared/maestro-coordinator-handoff'

export type CoordinatorHandoffRow = {
  request_id: string
  run_id: string
  phase: MaestroCoordinatorHandoffTerminalPhase
  predecessor_lease_id: string | null
  successor_lease_id: string
  successor_terminal_handle: string | null
  successor_tab_id: string | null
  successor_pty_incarnation: string | null
  capsule_digest: string
  input_idempotency_key: string
  claimed_generation: number
  expected_graph_revision: number
  observed_graph_revision: number | null
  blocked_code: string | null
  predecessor_retained: number
  created_at: string
  updated_at: string
}

export function deserializeCoordinatorHandoff(
  row: CoordinatorHandoffRow
): MaestroCoordinatorHandoffReceipt {
  return {
    requestId: row.request_id,
    runId: row.run_id,
    phase: row.phase,
    predecessorLeaseId: row.predecessor_lease_id,
    successorLeaseId: row.successor_lease_id,
    successorTerminalHandle: row.successor_terminal_handle,
    successorTabId: row.successor_tab_id,
    successorPtyIncarnation: row.successor_pty_incarnation,
    capsuleDigest: row.capsule_digest,
    inputIdempotencyKey: row.input_idempotency_key,
    claimedGeneration: row.claimed_generation,
    expectedGraphRevision: row.expected_graph_revision,
    observedGraphRevision: row.observed_graph_revision,
    blockedCode: row.blocked_code,
    predecessorRetained: row.predecessor_retained === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
