import type { DispatchContextRow, WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from '../../context-only-dispatch-release'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'

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
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'stopping', stage = 'stop_requested',
             runtime_epoch = COALESCE(?, runtime_epoch), updated_at = datetime('now')
         WHERE dispatch_id = ? AND state IN ('ready', 'start_unknown')`
      )
      .run(runtimeEpoch, dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
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
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = 'failed', completed_at = datetime('now'), last_failure = 'stopped'
         WHERE id = ? AND status IN ('pending', 'dispatched')`
      )
      .run(dispatchId)
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
  this.db.exec('BEGIN IMMEDIATE')
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
      this.db.exec('COMMIT')
      return worker
    }
    if (!['stopping', 'stop_unknown'].includes(worker.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Federated Dispatch ${dispatchId} cannot reconcile stop from ${worker.state}.`
      )
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'stopped', stage = 'process_stopped', last_error = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state IN ('stopping', 'stop_unknown')`
      )
      .run(dispatchId)
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now')),
             last_failure = 'stopped'
         WHERE id = ? AND status IN ('pending', 'dispatched')`
      )
      .run(dispatchId)
    reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
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
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'ready', stage = 'remote_report_pending', updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(dispatchId)
    this.db
      .prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ? AND status = 'blocked'")
      .run(dispatch.task_id)
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
  this.db
    .prepare(
      `UPDATE worker_dispatches
       SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?,
           updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'stopping'`
    )
    .run(reason, dispatchId)
  return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
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
