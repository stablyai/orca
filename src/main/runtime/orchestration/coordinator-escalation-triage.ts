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
  let dispatchId: string | undefined
  if (msg.payload) {
    try {
      const payload = JSON.parse(msg.payload)
      taskId = payload.taskId
      dispatchId = payload.dispatchId
    } catch {
      // Escalation without structured payload — log subject as context
    }
  }

  if (!taskId || !dispatchId) {
    onLog(`Rejected escalation from ${msg.from_handle}: missing exact Dispatch binding`)
    return null
  }

  const task = db.getTask(taskId)
  if (!task || task.status === 'completed' || task.status === 'failed') {
    return null
  }

  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || dispatch.task_id !== taskId) {
    onLog(`Rejected escalation from ${msg.from_handle}: Dispatch does not own Task ${taskId}`)
    return null
  }
  // Why: every guard below only admits pending|dispatched, so a settled row (U6 'forgotten',
  // or a completed/failed one) would surface as a false ownership rejection or as a retry that
  // failDispatch already no-opped. Neither state changes here, so ordering this before the
  // sender check gives up no authority.
  if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
    onLog(
      `Ignoring escalation from ${msg.from_handle}: Dispatch ${dispatch.id} is already settled (${dispatch.status}); Task ${taskId} stays ${task.status} until an explicit retry.`
    )
    return null
  }
  if (
    !db.isDispatchMessageSender({
      dispatchId: dispatch.id,
      handle: msg.from_handle,
      paneKey: msg.sender_pane_key,
      allowCanonicalDispatchHandle: true
    })
  ) {
    onLog(`Rejected escalation from ${msg.from_handle}: it does not own Task ${taskId}`)
    return null
  }

  const worker = db.getWorkerDispatch(dispatch.id)
  if (worker && !['failed', 'succeeded', 'stopped', 'abandoned'].includes(worker.state)) {
    onLog(
      `Task ${taskId} remains dispatched until supervised worker ${dispatch.id} stops or reports.`
    )
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
