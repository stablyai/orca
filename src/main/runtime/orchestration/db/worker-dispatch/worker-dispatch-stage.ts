import type { WorkerDispatchRow, WorkerDispatchState } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerAuthorityIsolationAttestation } from '../../../../../shared/worker-authority-policy'

export function recordWorkerStage(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    stage: string
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
    state?: WorkerDispatchState
  }
): WorkerDispatchRow {
  const current = this.getWorkerDispatch(params.dispatchId)
  if (!current) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${params.dispatchId} was not found.`
    )
  }
  this.db
    .prepare(
      `UPDATE worker_dispatches
       SET stage = ?, state = ?, worktree_id = ?, agent_terminal_handle = ?,
           setup_state = ?, effects = ?, residual_resources = ?, last_error = ?,
           updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(
      params.stage,
      params.state ?? current.state,
      params.worktreeId ?? current.worktree_id,
      params.terminalHandle ?? current.agent_terminal_handle,
      params.setupState ?? current.setup_state,
      params.effects ? JSON.stringify(params.effects) : current.effects,
      params.residualResources
        ? JSON.stringify(params.residualResources)
        : current.residual_resources,
      params.lastError ?? current.last_error,
      params.dispatchId
    )
  return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
}

export function updateWorkerSetupEvidence(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }
): { worker: WorkerDispatchRow; changed: boolean } {
  const current = this.getWorkerDispatch(params.dispatchId)
  if (!current) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${params.dispatchId} was not found.`
    )
  }
  const effects = JSON.stringify(params.effects)
  if (current.setup_state === params.setupState && current.effects === effects) {
    return { worker: current, changed: false }
  }
  this.db
    .prepare(
      `UPDATE worker_dispatches
       SET setup_state = ?, effects = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(params.setupState, effects, params.dispatchId)
  return {
    worker: this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow,
    changed: true
  }
}

export function recordWorkerAuthorityAttestation(
  this: OrchestrationDb,
  dispatchId: string,
  attestation: WorkerAuthorityIsolationAttestation
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const current = this.getWorkerDispatch(dispatchId)
    if (!current || current.state !== 'starting') {
      throw new OrchestrationError(
        'worker_authority_attestation_missing',
        `Dispatch ${dispatchId} cannot accept an authority attestation.`
      )
    }
    const startOptions = JSON.parse(current.start_options) as Record<string, unknown>
    if (startOptions.authorityIsolation !== undefined) {
      throw new OrchestrationError(
        'worker_authority_replay_conflict',
        `Dispatch ${dispatchId} already has an authority attestation.`
      )
    }
    startOptions.authorityIsolation = attestation
    const updated = this.db
      .prepare(
        `UPDATE worker_dispatches
         SET start_options = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting' AND start_options = ?`
      )
      .run(JSON.stringify(startOptions), dispatchId, current.start_options)
    if (updated.changes !== 1) {
      throw new OrchestrationError(
        'worker_authority_replay_conflict',
        `Dispatch ${dispatchId} changed while recording its authority attestation.`
      )
    }
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchStageMethods = {
  recordWorkerStage: typeof recordWorkerStage
  updateWorkerSetupEvidence: typeof updateWorkerSetupEvidence
  recordWorkerAuthorityAttestation: typeof recordWorkerAuthorityAttestation
}

export function attachWorkerDispatchStage(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordWorkerStage,
    updateWorkerSetupEvidence,
    recordWorkerAuthorityAttestation
  })
}
