import type { MessageRow } from './types'

/**
 * Whether a `worker_done` payload names this Dispatch's own work.
 *
 * Why: parking a lane on a rejected report is a courtesy to a worker that really finished, so it
 * needs the same identity proof reconciliation applies — the right task, the right Dispatch and a
 * real outcome. A report that names another task, or no task, proves nothing about this lane and
 * must leave it as it was.
 */
export function isWorkerReportForDispatch(
  dispatch: { id: string; task_id: string },
  msg: MessageRow
): boolean {
  if (!msg.payload) {
    return false
  }
  const payload = parsePayloadObject(msg.payload)
  if (!payload) {
    return false
  }
  const outcome = payload.outcome
  return (
    payload.taskId === dispatch.task_id &&
    payload.dispatchId === dispatch.id &&
    (outcome === 'succeeded' || outcome === 'failed')
  )
}

function parsePayloadObject(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
