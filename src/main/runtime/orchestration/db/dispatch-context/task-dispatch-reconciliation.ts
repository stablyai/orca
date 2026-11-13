import type { DispatchContextRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'

export function getActiveDispatchForTask(
  db: OrchestrationDb,
  taskId: string
): DispatchContextRow | undefined {
  return db.db
    .prepare(
      "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
    )
    .get(taskId) as DispatchContextRow | undefined
}

export function reconcileTaskAfterDispatchInterruption(
  db: OrchestrationDb,
  taskId: string,
  dispatchId: string
): void {
  const task = db.getTask(taskId)
  if (!task || !['dispatched', 'blocked'].includes(task.status)) {
    return
  }
  const next = db.db
    .prepare(
      "SELECT 1 FROM dispatch_contexts WHERE task_id = ? AND id != ? AND status IN ('pending', 'dispatched')"
    )
    .get(taskId, dispatchId)
    ? 'dispatched'
    : 'blocked'
  if (task.status === next) {
    return
  }
  transitionLifecycleWithDb(db.db, {
    entity: 'task',
    id: taskId,
    from: task.status,
    to: next
  })
}

/**
 * A worker lost with its runtime (restart recovery) leaves its Task ready for a fresh start, or
 * failed once its retries broke the circuit, while no other attempt runs for it.
 */
export function settleTaskAfterLostWorker(
  db: OrchestrationDb,
  taskId: string,
  to: 'ready' | 'failed'
): void {
  const task = db.getTask(taskId)
  if (
    !task ||
    !['dispatched', 'blocked'].includes(task.status) ||
    getActiveDispatchForTask(db, taskId)
  ) {
    return
  }
  transitionLifecycleWithDb(db.db, {
    entity: 'task',
    id: taskId,
    from: task.status,
    to,
    projection: { completed_at: to === 'failed' ? new Date().toISOString() : null }
  })
}
