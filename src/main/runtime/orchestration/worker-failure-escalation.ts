import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow, MessageRow } from './types'

export type WorkerFailureEscalation = {
  /** The worker's own handle: the escalation is from it. */
  from: string
  /** Resolve caller-specific routing inside the failure boundary. Defaults to the owning Run. */
  mailbox?: () => string
  /** Builds the subject and body around the task's display name, `"<title>" (<task id>)`. */
  describe: (task: string) => { subject: string; body: string }
  payload: Record<string, unknown>
  /** Stable when one failure can be reported more than once; an existing id is not sent again. */
  id?: string
}

/**
 * Tell the coordinator that owns a Dispatch its worker failed. One path for every kind of worker,
 * so a terminal that exited and a chat whose turn failed reach the coordinator in the same shape.
 * Throws nothing: the worker's own failure handling must never depend on this mail.
 */
export function escalateWorkerFailure(
  db: OrchestrationDb,
  dispatch: Pick<DispatchContextRow, 'id' | 'run_id' | 'task_id'>,
  escalation: WorkerFailureEscalation,
  notify: (handle: string, messageType: string) => void
): MessageRow | null {
  try {
    if (escalation.id && db.getMessageById?.(escalation.id)) {
      return null
    }
    const owningRun = db.getRun?.(dispatch.run_id)
    const active = db.getActiveCoordinatorRun?.()
    const to =
      owningRun && owningRun.legacy !== 1
        ? (escalation.mailbox?.() ?? `run:${owningRun.id}`)
        : (active?.coordinator_handle ?? null)
    if (!to) {
      return null
    }
    const task = db.getTask?.(dispatch.task_id, dispatch.run_id)
    // Why: prefer the explicit task title and keep the derived one single-line and bounded;
    // a raw multi-paragraph spec inlined here breaks the coordinator's escalation banner.
    const title =
      typeof task?.spec === 'string'
        ? buildOrchestrationTaskDisplayMetadata({
            spec: task.spec,
            taskTitle: task.task_title,
            displayName: task.display_name
          }).taskTitle
        : ''
    const { subject, body } = escalation.describe(
      title ? `"${title}" (${dispatch.task_id})` : dispatch.task_id
    )
    const message = db.insertMessage({
      ...(escalation.id ? { id: escalation.id } : {}),
      from: escalation.from,
      to,
      subject,
      body,
      type: 'escalation',
      priority: 'high',
      payload: JSON.stringify(escalation.payload),
      runId: dispatch.run_id
    })
    notify(message.to_handle, message.type)
    return message
  } catch (error) {
    console.warn('[orchestration] failed to escalate worker failure', {
      dispatchId: dispatch.id,
      runId: dispatch.run_id,
      error
    })
    return null
  }
}
