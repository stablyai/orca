import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from '../../context-only-dispatch-release'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'

export function abandonWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string
):
  | {
      disposition: 'abandoned' | 'already_abandoned' | 'stale'
      worker: WorkerDispatchRow
    }
  | ({ disposition: 'context_only' } & ContextOnlyDispatchReleaseResult) {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const worker = this.getWorkerDispatch(dispatchId)
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (!worker) {
      const released = releaseContextOnlyDispatch(this.db, dispatch, 'abandoned')
      if (!released.alreadySettled) {
        this.closeQuestionsForDispatch(dispatchId)
      }
      this.db.exec('COMMIT')
      return { disposition: 'context_only', ...released }
    }
    if (worker.state === 'abandoned') {
      this.db.exec('COMMIT')
      return { disposition: 'already_abandoned', worker }
    }
    if (this.getDispatchContext(dispatch.task_id)?.id !== dispatchId) {
      this.db.exec('COMMIT')
      return { disposition: 'stale', worker }
    }
    if (worker.state === 'stopping') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is stopping; wait for worker-stop to settle before abandoning.`
      )
    }
    if (worker.state === 'succeeded') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} already succeeded and cannot be abandoned.`
      )
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'abandoned', stage = 'abandoned', updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = CASE WHEN status IN ('pending', 'dispatched') THEN 'failed' ELSE status END,
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')),
             completed_at = COALESCE(completed_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
    reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return {
      disposition: 'abandoned',
      worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchAbandonMethods = {
  abandonWorkerDispatch: typeof abandonWorkerDispatch
}

export function attachWorkerDispatchAbandon(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    abandonWorkerDispatch
  })
}
