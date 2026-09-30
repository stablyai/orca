import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from '../../context-only-dispatch-release'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'
import { transitionLifecycleWithDb } from '../lifecycle-transition'

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
    if (worker.state === 'failed' || worker.state === 'stopped') {
      this.db.exec('COMMIT')
      return { disposition: 'stale', worker }
    }
    if (worker.state === 'succeeded') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} already succeeded and cannot be abandoned.`
      )
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: worker.state,
      to: 'abandoned',
      projection: { stage: 'abandoned', updated_at: new Date().toISOString() }
    })
    if (['pending', 'dispatched'].includes(dispatch.status)) {
      transitionLifecycleWithDb(this.db, {
        entity: 'dispatch',
        id: dispatchId,
        from: dispatch.status,
        to: 'failed',
        projection: {
          capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString(),
          completed_at: dispatch.completed_at ?? new Date().toISOString()
        }
      })
    }
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
