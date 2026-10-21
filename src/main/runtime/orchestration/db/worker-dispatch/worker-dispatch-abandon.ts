import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from '../../context-only-dispatch-release'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'
import { isStopStrandedByAnotherRuntime } from './worker-dispatch-stop'
import { retainTerminalResourceInTransaction } from '../worker-terminal/worker-terminal-archive'

export function abandonWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string,
  runtimeEpoch: string,
  abandonedBy?: string
):
  | {
      disposition: 'abandoned' | 'already_abandoned' | 'already_settled'
      worker: WorkerDispatchRow
      superseded: boolean
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
    // Only this runtime's own in-flight stop is refused: it always ends in stopped or stop_unknown.
    if (worker.state === 'stopping' && !isStopStrandedByAnotherRuntime(worker, runtimeEpoch)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is stopping; wait for worker-stop to settle before abandoning.`
      )
    }
    const settles = !WORKER_SETTLED_STATES.includes(worker.state)
    const superseded = this.getDispatchContext(dispatch.task_id)?.id !== dispatchId
    if (settles) {
      const now = new Date().toISOString()
      transitionLifecycleWithDb(this.db, {
        entity: 'worker',
        id: dispatchId,
        from: worker.state,
        to: 'abandoned',
        projection: {
          stage: 'abandoned',
          // Why: an unknown start or stop's diagnostic stays readable beside the attribution.
          last_error: [
            worker.last_error,
            `Abandoned by ${abandonedBy ?? 'an unidentified caller'}.`
          ]
            .filter(Boolean)
            .join(' '),
          updated_at: now
        }
      })
      if (['pending', 'dispatched'].includes(dispatch.status)) {
        transitionLifecycleWithDb(this.db, {
          entity: 'dispatch',
          id: dispatchId,
          from: dispatch.status,
          to: 'failed',
          projection: {
            last_failure: 'abandoned',
            capability_revoked_at: dispatch.capability_revoked_at ?? now,
            completed_at: dispatch.completed_at ?? now
          }
        })
      }
      reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
      this.closeQuestionsForDispatch(dispatchId)
      const terminal = this.getWorkerTerminalResourceByOwner(dispatchId)
      // Abandon hands an owned terminal back instead of closing it, by the same rule as worker-retain.
      if (terminal?.ownership_state === 'owned') {
        retainTerminalResourceInTransaction(this, terminal.id, dispatchId)
      }
    }
    this.db.exec('COMMIT')
    return {
      disposition: settles
        ? 'abandoned'
        : worker.state === 'abandoned'
          ? 'already_abandoned'
          : 'already_settled',
      superseded,
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
