import { extractString, normalizeTitleText } from './session-scanner-values'

export function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
