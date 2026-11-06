import type { OrchestrationDb } from './db'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import { parseScheduledWaitUntil } from '../../../shared/orchestration-scheduled-wait'
import { OrchestrationError } from './orchestration-error'

export type ScheduledWaitMessage = { until: string; reason: string }

export function scheduledWaitFromMessage(message: {
  type?: string
  body?: string
  payload?: string
}): ScheduledWaitMessage | undefined {
  let payload: { waitUntil?: unknown } | undefined
  try {
    payload = message.payload ? JSON.parse(message.payload) : undefined
  } catch {
    return undefined
  }
  if (!payload || payload.waitUntil === undefined) {
    return undefined
  }
  if (
    (message.type ?? 'status') !== 'status' ||
    typeof payload.waitUntil !== 'string' ||
    !message.body?.trim()
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'A scheduled wait requires a status message, --wait-until, and a nonempty --body explaining the reason.'
    )
  }
  try {
    return { until: parseScheduledWaitUntil(payload.waitUntil), reason: message.body.trim() }
  } catch (error) {
    throw new OrchestrationError(
      'invalid_argument',
      error instanceof Error ? error.message : 'Invalid scheduled wait deadline.'
    )
  }
}

export function assertScheduledWaitSender(
  db: OrchestrationDb,
  params: { to?: string; payload?: string },
  dispatchId: string | undefined,
  identity: { from: string; paneKey?: string; processIncarnation?: string }
): void {
  const dispatch = dispatchId ? db.getDispatchContextById(dispatchId) : undefined
  if (
    !dispatch ||
    dispatch.status !== 'dispatched' ||
    !db.isDispatchMessageSender({
      dispatchId: dispatch.id,
      handle: identity.from,
      paneKey: identity.paneKey
    }) ||
    (params.to &&
      params.to !== dispatchReportMailbox(db, dispatch) &&
      params.to !== `run:${dispatch.run_id}`)
  ) {
    throw new OrchestrationError(
      'sender_not_assignee',
      'Only the active worker may declare its own scheduled wait to its coordinator.'
    )
  }
  const payload: { taskId?: unknown } = params.payload ? JSON.parse(params.payload) : {}
  if (payload.taskId !== undefined && payload.taskId !== dispatch.task_id) {
    throw new OrchestrationError(
      'task_dispatch_mismatch',
      'The scheduled wait Task does not belong to this Dispatch.'
    )
  }
  if (
    dispatch.process_incarnation &&
    !db.isDispatchProcessCurrent({
      dispatchId: dispatch.id,
      paneKey: identity.paneKey ?? null,
      processIncarnation: identity.processIncarnation ?? null
    })
  ) {
    throw new OrchestrationError(
      'worker_identity_changed',
      'Only the exact worker process may declare a scheduled wait.'
    )
  }
}
