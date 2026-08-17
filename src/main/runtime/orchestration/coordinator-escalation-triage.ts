/** Turns a worker escalation into a dispatch failure, honoring the circuit breaker. */
import type { OrchestrationDb } from './db'
import type { MessageRow } from './types'

/** Returns the task id when the escalation broke the circuit (task is now failed), else null. */
export function applyEscalationToDispatch(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: (msg: string) => void
): string | null {
  let taskId: string | undefined
  if (msg.payload) {
    try {
      const payload = JSON.parse(msg.payload)
      taskId = payload.taskId
    } catch {
      // Escalation without structured payload — log subject as context
    }
  }

  if (!taskId) {
    return null
  }

  const task = db.getTask(taskId)
  if (!task || task.status === 'completed' || task.status === 'failed') {
    return null
  }

  const dispatch = db.getDispatchContext(taskId)
  if (!dispatch) {
    return null
  }

  // Why: fail the dispatch to increment the circuit breaker; under threshold the task returns to 'pending' for re-dispatch next tick.
  const updated = db.failDispatch(dispatch.id, msg.subject)
  if (updated?.status === 'circuit_broken') {
    onLog(`Task ${taskId} circuit broken after repeated failures`)
    db.updateTaskStatus(taskId, 'failed', `Circuit broken: ${msg.subject}`)
    return taskId
  }
  onLog(`Task ${taskId} will be retried (failure ${updated?.failure_count ?? 0}/3)`)
  return null
}
