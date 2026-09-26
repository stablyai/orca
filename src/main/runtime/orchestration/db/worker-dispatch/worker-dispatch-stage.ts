import type { WorkerDispatchRow, WorkerDispatchState } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'

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
  this.db.exec('SAVEPOINT worker_stage_transition')
  try {
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: params.dispatchId,
      from: current.state,
      to: params.state ?? current.state,
      projection: {
        stage: params.stage,
        worktree_id: params.worktreeId ?? current.worktree_id,
        agent_terminal_handle: params.terminalHandle ?? current.agent_terminal_handle,
        setup_state: params.setupState ?? current.setup_state,
        effects: params.effects ? JSON.stringify(params.effects) : current.effects,
        residual_resources: params.residualResources
          ? JSON.stringify(params.residualResources)
          : current.residual_resources,
        last_error: params.lastError ?? current.last_error,
        updated_at: new Date().toISOString()
      }
    })
    this.db.exec('RELEASE worker_stage_transition')
  } catch (error) {
    this.db.exec('ROLLBACK TO worker_stage_transition')
    this.db.exec('RELEASE worker_stage_transition')
    throw error
  }
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
  this.db.exec('SAVEPOINT worker_setup_transition')
  try {
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: params.dispatchId,
      from: current.state,
      to: current.state,
      projection: {
        setup_state: params.setupState,
        effects,
        updated_at: new Date().toISOString()
      }
    })
    this.db.exec('RELEASE worker_setup_transition')
  } catch (error) {
    this.db.exec('ROLLBACK TO worker_setup_transition')
    this.db.exec('RELEASE worker_setup_transition')
    throw error
  }
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
