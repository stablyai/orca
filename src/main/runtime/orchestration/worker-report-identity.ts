import type { MessageRow } from './types'

// Why: parking a lane on a rejected report needs the same identity proof reconciliation applies,
// or a report naming another task would move a lane it never worked.
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
