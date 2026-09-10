import type {
  MaestroTerminalInputEnvelope,
  MaestroTerminalInputReceipt,
  MaestroTerminalInputSender,
  TerminalInputReceiptState,
  TerminalInputSurface
} from '../../../../../shared/maestro-terminal-lease'
import { isSha256Digest } from '../../../../../shared/maestro-terminal-lease'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

type TerminalInputReceiptRow = {
  command_id: string
  idempotency_key: string
  content_digest: string
  enqueue_sequence: number
  sender_json: string
  lease_id: string
  execution_host_id: string
  workspace_key: string
  terminal_handle: string
  tab_id: string
  pty_incarnation: string
  expected_lifecycle_state: MaestroTerminalInputEnvelope['expectedLifecycleState']
  observed_input_surface: TerminalInputSurface
  expires_at: string
  expected_graph_revision: number | null
  state: TerminalInputReceiptState
  bytes_written: number
  enter_written: number
  acknowledged_graph_revision: number | null
  superseded_by_command_id: string | null
  rejection_code: string | null
  created_at: string
  updated_at: string
}

function deserializeTerminalInputReceipt(
  row: TerminalInputReceiptRow
): MaestroTerminalInputReceipt {
  return {
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    contentDigest: row.content_digest,
    enqueueSequence: row.enqueue_sequence,
    sender: JSON.parse(row.sender_json) as MaestroTerminalInputSender,
    leaseId: row.lease_id,
    executionHostId: row.execution_host_id,
    workspaceKey: row.workspace_key,
    terminalHandle: row.terminal_handle,
    tabId: row.tab_id,
    ptyIncarnation: row.pty_incarnation,
    expectedLifecycleState: row.expected_lifecycle_state,
    observedInputSurface: row.observed_input_surface,
    expiresAt: row.expires_at,
    expectedGraphRevision: row.expected_graph_revision,
    state: row.state,
    bytesWritten: row.bytes_written,
    enterWritten: row.enter_written === 1,
    acknowledgedGraphRevision: row.acknowledged_graph_revision,
    supersededByCommandId: row.superseded_by_command_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getMaestroTerminalInputReceipt(
  this: OrchestrationDb,
  commandId: string
): MaestroTerminalInputReceipt | undefined {
  const row = this.db
    .prepare('SELECT * FROM maestro_terminal_input_receipts WHERE command_id = ?')
    .get(commandId) as TerminalInputReceiptRow | undefined
  return row ? deserializeTerminalInputReceipt(row) : undefined
}

export function acceptMaestroTerminalInput(
  this: OrchestrationDb,
  envelope: MaestroTerminalInputEnvelope
): { receipt: MaestroTerminalInputReceipt; replayed: boolean } {
  const lease = this.getMaestroTerminalLease(envelope.leaseId)
  if (!lease) {
    throw new OrchestrationError(
      'lease_not_found',
      `Terminal lease ${envelope.leaseId} was not found.`
    )
  }
  if (lease.lifecycleState === 'superseded') {
    throw new OrchestrationError(
      'lease_state_conflict',
      'Superseded terminal leases cannot accept input.'
    )
  }
  const replay = this.db
    .prepare('SELECT * FROM maestro_terminal_input_receipts WHERE idempotency_key = ?')
    .get(envelope.idempotencyKey) as TerminalInputReceiptRow | undefined
  if (replay) {
    if (
      replay.command_id !== envelope.commandId ||
      replay.content_digest !== envelope.contentDigest ||
      replay.lease_id !== envelope.leaseId
    ) {
      throw new OrchestrationError(
        'mutation_conflict',
        `Input idempotency key ${envelope.idempotencyKey} has conflicting content.`
      )
    }
    return { receipt: deserializeTerminalInputReceipt(replay), replayed: true }
  }
  if (!isSha256Digest(envelope.contentDigest)) {
    throw new OrchestrationError('invalid_argument', 'Terminal input requires a SHA-256 digest.')
  }
  const identityMatches =
    lease.executionHostId === envelope.executionHostId &&
    lease.workspaceKey === envelope.workspaceKey &&
    lease.terminalHandle === envelope.terminalHandle &&
    lease.tabId === envelope.tabId &&
    lease.ptyIncarnation === envelope.ptyIncarnation
  if (!identityMatches) {
    throw new OrchestrationError(
      'terminal_incarnation_mismatch',
      'Terminal input does not target the exact leased PTY incarnation.'
    )
  }
  if (lease.lifecycleState !== envelope.expectedLifecycleState) {
    throw new OrchestrationError(
      'lease_state_conflict',
      `Terminal lease is ${lease.lifecycleState}, not ${envelope.expectedLifecycleState}.`
    )
  }
  if (Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new OrchestrationError('input_expired', 'Terminal input expired before acceptance.')
  }
  if (
    envelope.sender.runId !== lease.runId ||
    (envelope.sender.authority === 'coordinator' && envelope.sender.coordinatorGeneration === null)
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Terminal input sender lacks current Run authority.'
    )
  }
  if (envelope.sender.authority === 'coordinator') {
    const run = this.getRun(envelope.sender.runId)
    if (
      (run && run.consumer_generation !== envelope.sender.coordinatorGeneration) ||
      (!run && lease.spawnedBy !== envelope.sender.principalId)
    ) {
      throw new OrchestrationError('consumer_fenced', 'Coordinator input generation is stale.')
    }
  }
  const latest = this.db
    .prepare(
      `SELECT enqueue_sequence FROM maestro_terminal_input_receipts
       WHERE lease_id = ? ORDER BY enqueue_sequence DESC LIMIT 1`
    )
    .get(envelope.leaseId) as { enqueue_sequence: number } | undefined
  if (latest && envelope.enqueueSequence !== latest.enqueue_sequence + 1) {
    throw new OrchestrationError(
      'input_sequence_conflict',
      `Terminal input sequence must be ${latest.enqueue_sequence + 1}.`
    )
  }
  if (!latest && envelope.enqueueSequence !== 1) {
    throw new OrchestrationError(
      'input_sequence_conflict',
      'First terminal input sequence must be 1.'
    )
  }
  this.db
    .prepare(
      `INSERT INTO maestro_terminal_input_receipts (
        command_id, idempotency_key, content_digest, enqueue_sequence, sender_json,
        lease_id, execution_host_id, workspace_key, terminal_handle, tab_id,
        pty_incarnation, expected_lifecycle_state, observed_input_surface, expires_at,
        expected_graph_revision, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`
    )
    .run(
      envelope.commandId,
      envelope.idempotencyKey,
      envelope.contentDigest,
      envelope.enqueueSequence,
      JSON.stringify(envelope.sender),
      envelope.leaseId,
      envelope.executionHostId,
      envelope.workspaceKey,
      envelope.terminalHandle,
      envelope.tabId,
      envelope.ptyIncarnation,
      envelope.expectedLifecycleState,
      envelope.observedInputSurface,
      envelope.expiresAt,
      envelope.expectedGraphRevision
    )
  return {
    receipt: this.getMaestroTerminalInputReceipt(envelope.commandId) as MaestroTerminalInputReceipt,
    replayed: false
  }
}

export function transitionMaestroTerminalInput(
  this: OrchestrationDb,
  params: {
    commandId: string
    state: TerminalInputReceiptState
    bytesWritten?: number
    enterWritten?: boolean
    acknowledgedGraphRevision?: number | null
    supersededByCommandId?: string | null
    rejectionCode?: string | null
  }
): MaestroTerminalInputReceipt {
  const current = this.getMaestroTerminalInputReceipt(params.commandId)
  if (!current) {
    throw new OrchestrationError(
      'input_not_found',
      `Terminal input ${params.commandId} was not found.`
    )
  }
  const allowed: Readonly<Record<TerminalInputReceiptState, readonly TerminalInputReceiptState[]>> =
    {
      accepted: ['queued', 'written_to_pty', 'rejected', 'delivery_unknown'],
      queued: ['written_to_pty', 'rejected', 'superseded', 'delivery_unknown'],
      written_to_pty: ['acknowledged', 'delivery_unknown'],
      acknowledged: [],
      rejected: [],
      superseded: [],
      delivery_unknown: []
    }
  if (current.state !== params.state && !allowed[current.state].includes(params.state)) {
    throw new OrchestrationError(
      'input_state_conflict',
      `Terminal input cannot move from ${current.state} to ${params.state}.`
    )
  }
  if (params.state === 'acknowledged' && params.acknowledgedGraphRevision === undefined) {
    throw new OrchestrationError(
      'invalid_argument',
      'Acknowledgement requires a correlated graph revision.'
    )
  }
  this.db
    .prepare(
      `UPDATE maestro_terminal_input_receipts
       SET state = ?, bytes_written = COALESCE(?, bytes_written),
           enter_written = COALESCE(?, enter_written),
           acknowledged_graph_revision = COALESCE(?, acknowledged_graph_revision),
           superseded_by_command_id = COALESCE(?, superseded_by_command_id),
           rejection_code = COALESCE(?, rejection_code), updated_at = datetime('now')
       WHERE command_id = ?`
    )
    .run(
      params.state,
      params.bytesWritten ?? null,
      params.enterWritten === undefined ? null : params.enterWritten ? 1 : 0,
      params.acknowledgedGraphRevision ?? null,
      params.supersededByCommandId ?? null,
      params.rejectionCode ?? null,
      params.commandId
    )
  return this.getMaestroTerminalInputReceipt(params.commandId) as MaestroTerminalInputReceipt
}

export type MaestroTerminalInputStoreMethods = {
  getMaestroTerminalInputReceipt: typeof getMaestroTerminalInputReceipt
  acceptMaestroTerminalInput: typeof acceptMaestroTerminalInput
  transitionMaestroTerminalInput: typeof transitionMaestroTerminalInput
}

export function attachMaestroTerminalInputStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getMaestroTerminalInputReceipt,
    acceptMaestroTerminalInput,
    transitionMaestroTerminalInput
  })
}
