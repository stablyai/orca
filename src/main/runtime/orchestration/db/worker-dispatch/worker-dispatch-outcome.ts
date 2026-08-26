import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

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
    this.db
      .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
      .run(dispatchId)
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'ready', stage = 'input_accepted',
             effects = COALESCE(?, effects), updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(effects ? JSON.stringify(effects) : null, dispatchId)
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
  reason: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(reason, dispatchId)
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'failed', stage = ?, last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(stage, reason, dispatchId)
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', completed_at = datetime('now')
         WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM dispatch_contexts
           WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
         )`
      )
      .run(dispatch.task_id)
    this.closeQuestionsForDispatch(dispatchId)
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
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'start_unknown', stage = ?, last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(stage, reason, dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
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
