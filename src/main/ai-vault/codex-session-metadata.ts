import {
  asRecord,
  extractString,
  extractThreadSource,
  normalizeTitleText
} from './session-scanner-values'

export function isCodexWorkerSession(payload: Record<string, unknown>): boolean {
  const threadSource = extractThreadSource(payload)
  if (threadSource) {
    return threadSource.toLowerCase() !== 'user'
  }
  return Boolean(asRecord(asRecord(payload.source)?.subagent))
}

export function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
