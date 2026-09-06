import { asRecord, extractString, normalizeTitleText } from './session-scanner-values'

// Field readers for Codex's `session_meta` record, whose key spelling has drifted
// across Codex releases (snake_case rollouts, camelCase app-server rollouts).

export function isCodexWorkerSession(payload: Record<string, unknown>): boolean {
  const threadSource = extractString(payload.thread_source) ?? extractString(payload.threadSource)
  if (threadSource) {
    return threadSource.toLowerCase() !== 'user'
  }

  const source = asRecord(payload.source)
  return Boolean(asRecord(source?.subagent))
}

export function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
