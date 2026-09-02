import type { WorkerDispatchRow, WorkerDispatchState } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

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

export type WorkerDispatchStageMethods = {
  recordWorkerStage: typeof recordWorkerStage
  updateWorkerSetupEvidence: typeof updateWorkerSetupEvidence
}

export function attachWorkerDispatchStage(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordWorkerStage,
    updateWorkerSetupEvidence
  })
}
