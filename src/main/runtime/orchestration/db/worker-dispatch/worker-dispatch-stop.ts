import type { DispatchContextRow, WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from '../../context-only-dispatch-release'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'

export function isDispatchProcessCurrent(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }
): boolean {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  return Boolean(
    dispatch?.assignee_pane_key &&
    params.paneKey &&
    isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey) &&
    dispatch.process_incarnation &&
    params.processIncarnation === dispatch.process_incarnation
  )
}

export function beginWorkerStop(
  this: OrchestrationDb,
  dispatchId: string,
  runtimeEpoch: string
):
  | { disposition: 'stopping'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
  | { disposition: 'already_settled'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
  | ({ disposition: 'context_only' } & ContextOnlyDispatchReleaseResult) {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (!worker) {
      const released = releaseContextOnlyDispatch(this.db, dispatch, 'stopped')
      if (!released.alreadySettled) {
        this.closeQuestionsForDispatch(dispatchId)
      }
      this.db.exec('COMMIT')
      return { disposition: 'context_only', ...released }
    }
    if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
      this.db.exec('COMMIT')
      return { disposition: 'already_settled', worker, dispatch }
    }
    if (!['ready', 'start_unknown'].includes(worker.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} cannot stop from ${worker.state}.`
      )
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: worker.state,
      to: 'stopping',
      projection: {
        stage: 'stop_requested',
        runtime_epoch: runtimeEpoch,
        updated_at: new Date().toISOString()
      }
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: dispatch.status,
      to: dispatch.status,
      projection: {
        capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString()
      }
    })
    reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
    this.closeQuestionsForDispatch(dispatchId)
    this.db.exec('COMMIT')
    return {
      disposition: 'stopping',
      worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow,
      dispatch: this.getDispatchContextById(dispatchId) as DispatchContextRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function settleWorkerStop(this: OrchestrationDb, dispatchId: string): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const worker = this.getWorkerDispatch(dispatchId)
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!worker || !dispatch || worker.state !== 'stopping') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'stopping',
      to: 'stopped',
      projection: { stage: 'process_stopped', updated_at: new Date().toISOString() }
    })
    if (['pending', 'dispatched'].includes(dispatch.status)) {
      transitionLifecycleWithDb(this.db, {
        entity: 'dispatch',
        id: dispatchId,
        from: dispatch.status,
        to: 'failed',
        projection: { completed_at: new Date().toISOString(), last_failure: 'stopped' }
      })
    }
    reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function reconcileFederatedWorkerStop(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow {
  const transaction = beginLifecycleWriteTransaction(this.db, 'federated_worker_stop_reconcile')
  try {
    const worker = this.getWorkerDispatch(dispatchId)
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!worker || !dispatch || !this.getFederatedDispatch(dispatchId)) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${dispatchId} was not found.`
      )
    }
    if (worker.state === 'stopped') {
      commitLifecycleWriteTransaction(this.db, transaction)
      return worker
    }
    if (!['stopping', 'stop_unknown'].includes(worker.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Federated Dispatch ${dispatchId} cannot reconcile stop from ${worker.state}.`
      )
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: worker.state,
      to: 'stopped',
      projection: {
        stage: 'process_stopped',
        last_error: null,
        updated_at: new Date().toISOString()
      }
    })
    if (['pending', 'dispatched'].includes(dispatch.status)) {
      transitionLifecycleWithDb(this.db, {
        entity: 'dispatch',
        id: dispatchId,
        from: dispatch.status,
        to: 'failed',
        projection: {
          completed_at: dispatch.completed_at ?? new Date().toISOString(),
          last_failure: 'stopped'
        }
      })
    }
    reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
    commitLifecycleWriteTransaction(this.db, transaction)
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw error
  }
}

export function resumeFederatedWorkerForTerminalRelay(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const worker = this.getWorkerDispatch(dispatchId)
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!worker || !dispatch || worker.state !== 'stopping') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'stopping',
      to: 'ready',
      projection: { stage: 'remote_report_pending', updated_at: new Date().toISOString() }
    })
    const task = this.getTask(dispatch.task_id)
    if (task?.status === 'blocked') {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id: dispatch.task_id,
        from: 'blocked',
        to: 'dispatched'
      })
    }
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function markWorkerStopUnknown(
  this: OrchestrationDb,
  dispatchId: string,
  reason: string
): WorkerDispatchRow {
  const worker = this.getWorkerDispatch(dispatchId)
  if (!worker || worker.state !== 'stopping') {
    throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
  }
  this.db.exec('SAVEPOINT mark_worker_stop_unknown')
  try {
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'stopping',
      to: 'stop_unknown',
      projection: {
        stage: 'stop_outcome_unknown',
        last_error: reason,
        updated_at: new Date().toISOString()
      }
    })
    this.db.exec('RELEASE mark_worker_stop_unknown')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK TO mark_worker_stop_unknown')
    this.db.exec('RELEASE mark_worker_stop_unknown')
    throw error
  }
}

export type WorkerDispatchStopMethods = {
  isDispatchProcessCurrent: typeof isDispatchProcessCurrent
  beginWorkerStop: typeof beginWorkerStop
  settleWorkerStop: typeof settleWorkerStop
  reconcileFederatedWorkerStop: typeof reconcileFederatedWorkerStop
  resumeFederatedWorkerForTerminalRelay: typeof resumeFederatedWorkerForTerminalRelay
  markWorkerStopUnknown: typeof markWorkerStopUnknown
}

export function attachWorkerDispatchStop(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    isDispatchProcessCurrent,
    beginWorkerStop,
    settleWorkerStop,
    reconcileFederatedWorkerStop,
    resumeFederatedWorkerForTerminalRelay,
    markWorkerStopUnknown
  })
}
