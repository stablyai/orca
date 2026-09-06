import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import {
  adoptFailedStartTerminal,
  type FailedStartTerminalAdoption
} from '../worker-terminal/failed-start-terminal-adoption'

export function markWorkerDispatchReady(
  this: OrchestrationDb,
  dispatchId: string,
  effects?: unknown[]
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: 'pending',
      to: 'dispatched'
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'starting',
      to: 'ready',
      projection: {
        stage: 'input_accepted',
        effects: effects ? JSON.stringify(effects) : worker.effects
      }
    })
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function failWorkerStart(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  // Why (#16095): revocation exists to stop a worker acting on a dispatch that never landed. A
  // prompt whose turn start went unobserved provably landed, so its worker keeps the authority its
  // own report needs.
  options: {
    retainCapability?: boolean
    /** A start that died before authority attached still owns the terminal it created. */
    adoptResidualTerminal?: FailedStartTerminalAdoption
  } = {}
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    const now = new Date().toISOString()
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: dispatch.status,
      to: 'failed',
      projection: {
        last_failure: reason,
        completed_at: now,
        capability_revoked_at: options.retainCapability
          ? dispatch.capability_revoked_at
          : (dispatch.capability_revoked_at ?? now)
      }
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'starting',
      to: 'failed',
      projection: { stage, last_error: reason, updated_at: now }
    })
    const hasActiveDispatch = Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM dispatch_contexts
           WHERE task_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`
        )
        .get(dispatch.task_id)
    )
    const task = this.getTask(dispatch.task_id)
    if (!hasActiveDispatch && task && task.status !== 'completed') {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id: dispatch.task_id,
        from: task.status,
        to: 'failed',
        projection: { completed_at: now }
      })
    }
    this.closeQuestionsForDispatch(dispatchId)
    adoptFailedStartTerminal(
      this,
      this.getWorkerDispatch(dispatchId) as WorkerDispatchRow,
      options.adoptResidualTerminal
    )
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function markWorkerStartUnknown(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'starting',
      to: 'start_unknown',
      projection: { stage, last_error: reason, updated_at: new Date().toISOString() }
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: dispatch.status,
      to: dispatch.status
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'task',
      id: dispatch.task_id,
      from: 'dispatched',
      to: 'blocked'
    })
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerDispatchRow | undefined
}

export type WorkerDispatchOutcomeMethods = {
  markWorkerDispatchReady: typeof markWorkerDispatchReady
  failWorkerStart: typeof failWorkerStart
  markWorkerStartUnknown: typeof markWorkerStartUnknown
  getWorkerDispatch: typeof getWorkerDispatch
}

export function attachWorkerDispatchOutcome(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markWorkerDispatchReady,
    failWorkerStart,
    markWorkerStartUnknown,
    getWorkerDispatch
  })
}
