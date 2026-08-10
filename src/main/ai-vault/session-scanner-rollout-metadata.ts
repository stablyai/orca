import { asRecord, extractString, normalizeTitleText } from './session-scanner-values'

export function isRolloutWorkerSession(payload: Record<string, unknown>): boolean {
  const threadSource = extractString(payload.thread_source) ?? extractString(payload.threadSource)
  if (threadSource) {
    return threadSource.toLowerCase() !== 'user'
  }
  return Boolean(asRecord(asRecord(payload.source)?.subagent))
}

export function extractRolloutSessionMetadataTitle(
  payload: Record<string, unknown>
): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
