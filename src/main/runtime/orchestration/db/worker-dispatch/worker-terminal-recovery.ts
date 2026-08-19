import type {
  TaskStatus,
  DispatchStatus,
  WorkerDispatchRow,
  LegacyWorkerTerminalRecoveryRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { DISPATCH_CIRCUIT_BREAK_FAILURES } from '../dispatch-context/dispatch-circuit-breaker'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'

export function listLegacyWorkerTerminalRecoveryRows(
  this: OrchestrationDb
): LegacyWorkerTerminalRecoveryRow[] {
  return this.db
    .prepare(
      `SELECT dc.id AS dispatch_id, dc.task_id, dc.status AS dispatch_status,
              dc.contract_version, dc.assignee_handle, dc.assignee_pane_key,
              dc.process_incarnation, wd.state AS worker_state, wd.worktree_id,
              wd.agent_terminal_handle
       FROM dispatch_contexts dc
       INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
       WHERE wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
       ORDER BY dc.rowid`
    )
    .all() as LegacyWorkerTerminalRecoveryRow[]
}

export function reconcileMissingWorkerTerminal(
  this: OrchestrationDb,
  dispatchId: string,
  reason: string
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
      this.db.exec('COMMIT')
      return worker
    }

    const activeDispatch = dispatch.status === 'pending' || dispatch.status === 'dispatched'
    const stopWasPending = worker.state === 'stopping' || worker.state === 'stop_unknown'
    if (activeDispatch) {
      const failureCount = dispatch.failure_count + 1
      const dispatchStatus: DispatchStatus =
        failureCount >= DISPATCH_CIRCUIT_BREAK_FAILURES ? 'circuit_broken' : 'failed'
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = ?, failure_count = ?, last_failure = ?,
               completed_at = datetime('now'),
               capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ? AND status IN ('pending', 'dispatched')`
        )
        .run(dispatchStatus, failureCount, reason, dispatchId)
      if (!stopWasPending) {
        const taskStatus: TaskStatus = dispatchStatus === 'circuit_broken' ? 'failed' : 'ready'
        reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
        this.db
          .prepare(
            `UPDATE tasks
             SET status = ?, completed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END
             WHERE id = ? AND status IN ('dispatched', 'blocked')
               AND NOT EXISTS (
                 SELECT 1 FROM dispatch_contexts
                 WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
               )`
          )
          .run(taskStatus, taskStatus, dispatch.task_id)
      }
      this.closeQuestionsForDispatch(dispatchId)
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = ?, stage = 'terminal_missing', last_error = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?
           AND state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')`
      )
      .run(stopWasPending ? 'stopped' : 'abandoned', reason, dispatchId)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalRecoveryMethods = {
  listLegacyWorkerTerminalRecoveryRows: typeof listLegacyWorkerTerminalRecoveryRows
  reconcileMissingWorkerTerminal: typeof reconcileMissingWorkerTerminal
}

export function attachWorkerTerminalRecovery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listLegacyWorkerTerminalRecoveryRows,
    reconcileMissingWorkerTerminal
  })
}
