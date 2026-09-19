import type {
  TaskStatus,
  DispatchStatus,
  WorkerDispatchRow,
  DispatchContextRow,
  LegacyWorkerTerminalRecoveryRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { DISPATCH_CIRCUIT_BREAK_FAILURES } from '../dispatch-context/dispatch-circuit-breaker'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { DISPATCH_CONTEXT_COLUMNS, selectColumns } from '../row-column-lists'

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

// Residual M: a Dispatch created by `orchestration dispatch --inject` (or any other
// context-only claim) has no worker_dispatches row, so listLegacyWorkerTerminalRecoveryRows'
// INNER JOIN never surfaces it and it stays pending/dispatched forever if its pane never
// exits under Orca's own eyes. `findActiveDispatchForAssignee` already keeps at most one
// active Dispatch per assignee handle/pane, so this needs no ambiguity filter of its own.
export function listUnsupervisedActiveDispatches(this: OrchestrationDb): DispatchContextRow[] {
  return this.db
    .prepare(
      `SELECT ${selectColumns(DISPATCH_CONTEXT_COLUMNS, 'dc')} FROM dispatch_contexts dc
       LEFT JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
       WHERE wd.dispatch_id IS NULL
         AND dc.status IN ('pending', 'dispatched')
         AND dc.assignee_handle IS NOT NULL`
    )
    .all() as DispatchContextRow[]
}

// Why the return type is nullable: an unsupervised (context-only) Dispatch has no
// worker_dispatches row to report back — residual M reuses this path for those, and it
// must not fabricate one (see the `!worker` branch below).
export function reconcileMissingWorkerTerminal(
  this: OrchestrationDb,
  dispatchId: string,
  reason: string
): WorkerDispatchRow | null {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (worker && ['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
      this.db.exec('COMMIT')
      return worker
    }

    const activeDispatch = dispatch.status === 'pending' || dispatch.status === 'dispatched'
    if (!worker && !activeDispatch) {
      // Why: an unsupervised Dispatch already settled has nothing left to reconcile.
      this.db.exec('COMMIT')
      return null
    }
    const stopWasPending = worker?.state === 'stopping' || worker?.state === 'stop_unknown'
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
          // Why 'unknown': a missing terminal proves nothing about how the process ended,
          // only that Orca lost the ability to observe it. Never a proven exit.
          termination_reason: 'unknown',
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
    if (!worker) {
      // Why: an unsupervised Dispatch has no worker_dispatches row; the dispatch_contexts
      // failure above is its whole settlement, and there is nothing here to update.
      this.db.exec('COMMIT')
      return null
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
  listUnsupervisedActiveDispatches: typeof listUnsupervisedActiveDispatches
  reconcileMissingWorkerTerminal: typeof reconcileMissingWorkerTerminal
}

export function attachWorkerTerminalRecovery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listLegacyWorkerTerminalRecoveryRows,
    listUnsupervisedActiveDispatches,
    reconcileMissingWorkerTerminal
  })
}
