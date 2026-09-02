import { asRecord, extractString, normalizeTitleText } from './session-scanner-values'

/** Codex writes worker/sub-agent transcripts into the same tree; only user-started threads list. */
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
