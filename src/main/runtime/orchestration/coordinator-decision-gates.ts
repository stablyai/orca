/** Decision-gate handling: opening a gate from a worker message and keeping gated tasks blocked. */
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import type { MessageRow } from './types'

export function openDecisionGateFromMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: (msg: string) => void
): void {
  onLog(`Decision gate from ${msg.from_handle}: ${msg.subject}`)

  let payload: { taskId?: string; dispatchId?: string; question?: string; options?: string[] } = {}
  if (msg.payload) {
    try {
      payload = JSON.parse(msg.payload)
    } catch {
      return
    }
  }

  if (!payload.taskId || !payload.dispatchId || !payload.question) {
    onLog(`Warning: decision_gate missing taskId, dispatchId, or question`)
    return
  }

  try {
    db.createGate({
      taskId: payload.taskId,
      question: payload.question,
      options: payload.options,
      requester: {
        handle: msg.from_handle,
        paneKey: msg.sender_pane_key,
        dispatchId: payload.dispatchId
      }
    })
  } catch (error) {
    if (
      error instanceof OrchestrationError &&
      (error.code === 'consumer_fenced' || error.code === 'task_not_startable')
    ) {
      onLog(`Rejected decision gate from ${msg.from_handle}: ${error.message}`)
      return
    }
    throw error
  }

  onLog(`Task ${payload.taskId} blocked on decision gate`)
}

export function reblockTasksWithPendingGates(db: OrchestrationDb): void {
  // Why: the coordinator never auto-resolves gates (humans do, via orchestration.gateResolve) — that would defeat them as approval checkpoints.
  const pendingGates = db.listGates({ status: 'pending' })
  for (const gate of pendingGates) {
    const task = db.getTask(gate.task_id)
    if (task && task.status !== 'blocked') {
      // Why: gate exists but task isn't blocked — re-block to restore the invariant.
      db.updateTaskStatus(gate.task_id, 'blocked')
    }
  }
}
