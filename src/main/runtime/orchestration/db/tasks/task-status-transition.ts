import { OrchestrationError } from '../../orchestration-error'
import type { TaskRow, TaskStatus } from '../../types'
import { settleActiveDispatchesForTask } from '../dispatch-context/dispatch-completion'
import type { OrchestrationDb } from '../orchestration-db'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'

const UPDATE_TASK_STATUS_SAVEPOINT = 'update_task_status'

export function updateTaskStatus(
  this: OrchestrationDb,
  id: string,
  status: TaskStatus,
  result?: string
): TaskRow | undefined {
  const terminalStatus = status === 'completed' || status === 'failed'
  const requiresActiveDispatch = status === 'dispatched'
  const permitsActiveDispatch = terminalStatus || requiresActiveDispatch
  // Why: reserve the WAL writer before lifecycle reads so a concurrent commit cannot stale the snapshot.
  const transaction = beginLifecycleWriteTransaction(this.db, UPDATE_TASK_STATUS_SAVEPOINT)
  try {
    const task = this.getTask(id)
    if (!task) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return undefined
    }
    const active = this.db
      .prepare(
        `SELECT id FROM dispatch_contexts
         WHERE task_id = ? AND status IN ('pending', 'dispatched')
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(id) as { id: string } | undefined
    const activeWorker = terminalStatus
      ? (this.db
          .prepare(
            `SELECT active.id
             FROM dispatch_contexts active
             JOIN worker_dispatches worker ON worker.dispatch_id = active.id
             WHERE active.task_id = ? AND active.status IN ('pending', 'dispatched')
               AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
             ORDER BY active.rowid DESC LIMIT 1`
          )
          .get(id) as { id: string } | undefined)
      : undefined
    if (activeWorker) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${id} cannot move to ${status} while supervised Dispatch ${activeWorker.id} is active; stop or settle its worker first.`,
        { taskId: id, dispatchId: activeWorker.id }
      )
    }
    if (requiresActiveDispatch && !active) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${id} cannot move to dispatched without an active Dispatch.`,
        { taskId: id }
      )
    }
    if (active && !permitsActiveDispatch) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${id} cannot move to ${status} while Dispatch ${active.id} is active.`,
        { taskId: id, dispatchId: active.id }
      )
    }
    if (task.status === status && result === undefined) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return task
    }
    try {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id,
        from: task.status,
        to: status,
        projection: {
          result: result ?? task.result,
          completed_at: terminalStatus ? new Date().toISOString() : task.completed_at
        }
      })
    } catch (error) {
      if (!(error instanceof OrchestrationError) || error.code !== 'lifecycle_conflict') {
        throw error
      }
      const current = this.getTask(id)
      // A concurrent writer may have already applied the requested status;
      // preserve idempotency for that race, but never hide an invalid edge.
      if (!current || current.status !== status) {
        throw error
      }
      commitLifecycleWriteTransaction(this.db, transaction)
      return current
    }
    if (terminalStatus) {
      settleActiveDispatchesForTask(this, id, status, result)
    }
    if (status === 'completed') {
      this.promoteReadyTasks(id)
    }
    const updatedTask = this.getTask(id)
    commitLifecycleWriteTransaction(this.db, transaction)
    return updatedTask
  } catch (error) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw error
  }
}

export type TaskStatusTransitionMethods = {
  updateTaskStatus: typeof updateTaskStatus
}

export function attachTaskStatusTransition(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { updateTaskStatus })
}
