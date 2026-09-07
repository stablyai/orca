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
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'

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
          -- A settled worker whose terminal orchestration still owns keeps a resumable agent
          -- session; it needs the resume fence until release or retain retires the pane.
          OR (wd.state IN (${WORKER_SETTLED_STATES.map(() => '?').join(', ')})
              AND EXISTS (
                SELECT 1 FROM worker_terminal_resources wtr
                 WHERE wtr.owner_dispatch_id = dc.id
                   AND wtr.ownership_state = 'owned'
                   AND wtr.release_state NOT IN ('released', 'retained')
              ))
       ORDER BY dc.rowid`
    )
    .all(...WORKER_SETTLED_STATES) as LegacyWorkerTerminalRecoveryRow[]
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
      transitionLifecycleWithDb(this.db, {
        entity: 'dispatch',
        id: dispatchId,
        from: dispatch.status,
        to: dispatchStatus,
        projection: {
          failure_count: failureCount,
          last_failure: reason,
          completed_at: new Date().toISOString(),
          capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString()
        }
      })
      if (!stopWasPending) {
        const taskStatus: TaskStatus = dispatchStatus === 'circuit_broken' ? 'failed' : 'ready'
        reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
        const task = this.getTask(dispatch.task_id)
        if (
          task &&
          ['dispatched', 'blocked'].includes(task.status) &&
          !this.db
            .prepare(
              "SELECT 1 FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched')"
            )
            .get(dispatch.task_id)
        ) {
          transitionLifecycleWithDb(this.db, {
            entity: 'task',
            id: dispatch.task_id,
            from: task.status,
            to: taskStatus,
            projection: { completed_at: taskStatus === 'failed' ? new Date().toISOString() : null }
          })
        }
      }
      this.closeQuestionsForDispatch(dispatchId)
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: worker.state,
      to: stopWasPending ? 'stopped' : 'abandoned',
      projection: {
        stage: 'terminal_missing',
        last_error: reason,
        updated_at: new Date().toISOString()
      }
    })
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
