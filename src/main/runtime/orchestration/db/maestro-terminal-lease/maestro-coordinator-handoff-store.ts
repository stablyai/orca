import {
  canAdvanceCoordinatorHandoff,
  type MaestroCoordinatorHandoffPhase,
  type MaestroCoordinatorHandoffReceipt
} from '../../../../../shared/maestro-coordinator-handoff'
import type { MaestroTerminalLaunchProfile } from '../../../../../shared/maestro-terminal-lease'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  deserializeCoordinatorHandoff,
  type CoordinatorHandoffRow
} from './maestro-coordinator-handoff-row'

export function getCoordinatorHandoff(
  this: OrchestrationDb,
  requestId: string
): MaestroCoordinatorHandoffReceipt | undefined {
  const row = this.db
    .prepare('SELECT * FROM maestro_coordinator_handoff_receipts WHERE request_id = ?')
    .get(requestId) as CoordinatorHandoffRow | undefined
  return row ? deserializeCoordinatorHandoff(row) : undefined
}

export function reserveCoordinatorHandoff(
  this: OrchestrationDb,
  params: {
    requestId: string
    runId: string
    executionHostId: string
    workspaceKey: string
    title: string
    launchProfile: MaestroTerminalLaunchProfile
    spawnedBy: string
    ownerPrincipal: string
    capsuleDigest: string
    inputIdempotencyKey: string
    expectedGraphRevision: number
    retentionPolicy: 'auto_release' | 'retain'
  }
): MaestroCoordinatorHandoffReceipt {
  const replay = this.getCoordinatorHandoff(params.requestId)
  if (replay) {
    if (
      replay.runId !== params.runId ||
      replay.capsuleDigest !== params.capsuleDigest ||
      replay.inputIdempotencyKey !== params.inputIdempotencyKey
    ) {
      throw new OrchestrationError(
        'mutation_conflict',
        `Coordinator handoff ${params.requestId} has conflicting content.`
      )
    }
    return replay
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRunRaw(params.runId)
    if (!run || run.legacy === 1) {
      throw new OrchestrationError('run_not_found', `Run ${params.runId} was not found.`)
    }
    const claimedGeneration = run.consumer_generation + 1
    const predecessor = this.getCoordinatorLease(params.runId, run.consumer_generation)
    const successor = this.reserveMaestroTerminalLease({
      requestId: `handoff:${params.requestId}`,
      executionHostId: params.executionHostId,
      workspaceKey: params.workspaceKey,
      runId: params.runId,
      coordinatorGeneration: claimedGeneration,
      role: 'coordinator',
      coordinatorRunId: params.runId,
      title: params.title,
      launchProfile: params.launchProfile,
      parentLeaseId: predecessor?.id ?? null,
      spawnedBy: params.spawnedBy,
      ownerPrincipal: params.ownerPrincipal,
      retentionPolicy: params.retentionPolicy,
      capsuleDigest: params.capsuleDigest
    })
    this.db
      .prepare(
        `INSERT INTO maestro_coordinator_handoff_receipts (
          request_id, run_id, phase, predecessor_lease_id, successor_lease_id,
          capsule_digest, input_idempotency_key, claimed_generation,
          expected_graph_revision, predecessor_retained
        ) VALUES (?, ?, 'reserved', ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        params.requestId,
        params.runId,
        predecessor?.id ?? null,
        successor.id,
        params.capsuleDigest,
        params.inputIdempotencyKey,
        claimedGeneration,
        params.expectedGraphRevision
      )
    if (predecessor) {
      this.retainMaestroTerminalLease(predecessor.id)
    }
    if (run.coordinator_handle) {
      this.routeAllUnreadDirectMessagesToRunMailbox(params.runId, run.coordinator_handle)
    }
    this.db
      .prepare(
        `UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
         consumer_generation = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(claimedGeneration, params.runId)
    this.migrateOutstandingDelivery(params.runId, claimedGeneration)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getCoordinatorHandoff(params.requestId) as MaestroCoordinatorHandoffReceipt
}

export function advanceCoordinatorHandoff(
  this: OrchestrationDb,
  params: {
    requestId: string
    phase: Exclude<MaestroCoordinatorHandoffPhase, 'reserved' | 'authority_committed'>
    terminalHandle?: string | null
    tabId?: string | null
    ptyIncarnation?: string | null
    observedGraphRevision?: number | null
  }
): MaestroCoordinatorHandoffReceipt {
  const current = this.getCoordinatorHandoff(params.requestId)
  if (!current) {
    throw new OrchestrationError('handoff_not_found', `Handoff ${params.requestId} was not found.`)
  }
  if (!canAdvanceCoordinatorHandoff(current.phase, params.phase)) {
    throw new OrchestrationError(
      'handoff_phase_conflict',
      `Handoff cannot move from ${current.phase} to ${params.phase}.`
    )
  }
  if (params.phase === 'capsule_delivery_acknowledged') {
    const input = this.db
      .prepare('SELECT state FROM maestro_terminal_input_receipts WHERE idempotency_key = ?')
      .get(current.inputIdempotencyKey) as { state: string } | undefined
    if (input?.state !== 'acknowledged') {
      throw new OrchestrationError(
        'delivery_unacknowledged',
        'Coordinator capsule delivery has not been acknowledged.'
      )
    }
  }
  if (
    params.phase === 'coordinator_claimed' &&
    (params.observedGraphRevision ?? -1) < current.expectedGraphRevision
  ) {
    throw new OrchestrationError(
      'claim_revision_stale',
      'Coordinator claim did not reach the expected graph revision.'
    )
  }
  this.db
    .prepare(
      `UPDATE maestro_coordinator_handoff_receipts
       SET phase = ?, successor_terminal_handle = COALESCE(?, successor_terminal_handle),
           successor_tab_id = COALESCE(?, successor_tab_id),
           successor_pty_incarnation = COALESCE(?, successor_pty_incarnation),
           observed_graph_revision = COALESCE(?, observed_graph_revision),
           updated_at = datetime('now') WHERE request_id = ?`
    )
    .run(
      params.phase,
      params.terminalHandle ?? null,
      params.tabId ?? null,
      params.ptyIncarnation ?? null,
      params.observedGraphRevision ?? null,
      params.requestId
    )
  return this.getCoordinatorHandoff(params.requestId) as MaestroCoordinatorHandoffReceipt
}

export function commitCoordinatorHandoffAuthority(
  this: OrchestrationDb,
  params: { requestId: string; coordinatorPaneKey: string }
): MaestroCoordinatorHandoffReceipt {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const handoff = this.getCoordinatorHandoff(params.requestId)
    if (!handoff) {
      throw new OrchestrationError(
        'handoff_not_found',
        `Handoff ${params.requestId} was not found.`
      )
    }
    if (!canAdvanceCoordinatorHandoff(handoff.phase, 'authority_committed')) {
      throw new OrchestrationError(
        'handoff_phase_conflict',
        `Handoff cannot commit authority from ${handoff.phase}.`
      )
    }
    const run = this.getRunRaw(handoff.runId)
    if (
      !run ||
      run.consumer_generation !== handoff.claimedGeneration ||
      (run.coordinator_handle !== null &&
        run.coordinator_handle !== handoff.successorTerminalHandle)
    ) {
      throw new OrchestrationError('consumer_fenced', 'Run authority changed during handoff.')
    }
    if (!handoff.successorTerminalHandle || !handoff.successorPtyIncarnation) {
      throw new OrchestrationError(
        'handoff_incomplete',
        'Successor terminal identity is incomplete.'
      )
    }
    const successor = this.db
      .prepare(
        `UPDATE maestro_terminal_leases SET lifecycle_state = 'active',
         updated_at = datetime('now') WHERE id = ? AND lifecycle_state = 'ready'`
      )
      .run(handoff.successorLeaseId)
    if (successor.changes !== 1) {
      throw new OrchestrationError(
        'handoff_incomplete',
        'Successor lease was not durably ready for authority commit.'
      )
    }
    this.unbindOtherRunsForPane(params.coordinatorPaneKey, handoff.runId)
    this.rememberRunCoordinatorHandle(handoff.runId, handoff.successorTerminalHandle)
    this.db
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
         consumer_generation = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(
        handoff.successorTerminalHandle,
        params.coordinatorPaneKey,
        handoff.claimedGeneration,
        handoff.runId
      )
    this.db
      .prepare(
        `UPDATE maestro_coordinator_handoff_receipts
         SET phase = 'authority_committed', updated_at = datetime('now') WHERE request_id = ?`
      )
      .run(params.requestId)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getCoordinatorHandoff(params.requestId) as MaestroCoordinatorHandoffReceipt
}

export function blockCoordinatorHandoff(
  this: OrchestrationDb,
  params: { requestId: string; phase: 'blocked' | 'outcome_unknown'; code: string }
): MaestroCoordinatorHandoffReceipt {
  const handoff = this.getCoordinatorHandoff(params.requestId)
  if (!handoff) {
    throw new OrchestrationError('handoff_not_found', `Handoff ${params.requestId} was not found.`)
  }
  if (handoff.predecessorLeaseId) {
    this.retainMaestroTerminalLease(handoff.predecessorLeaseId)
  }
  this.db
    .prepare(
      `UPDATE maestro_coordinator_handoff_receipts
       SET phase = ?, blocked_code = ?, predecessor_retained = 1,
           updated_at = datetime('now') WHERE request_id = ?`
    )
    .run(params.phase, params.code, params.requestId)
  return this.getCoordinatorHandoff(params.requestId) as MaestroCoordinatorHandoffReceipt
}

export type MaestroCoordinatorHandoffStoreMethods = {
  getCoordinatorHandoff: typeof getCoordinatorHandoff
  reserveCoordinatorHandoff: typeof reserveCoordinatorHandoff
  advanceCoordinatorHandoff: typeof advanceCoordinatorHandoff
  commitCoordinatorHandoffAuthority: typeof commitCoordinatorHandoffAuthority
  blockCoordinatorHandoff: typeof blockCoordinatorHandoff
}

export function attachMaestroCoordinatorHandoffStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getCoordinatorHandoff,
    reserveCoordinatorHandoff,
    advanceCoordinatorHandoff,
    commitCoordinatorHandoffAuthority,
    blockCoordinatorHandoff
  })
}
