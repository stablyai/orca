import { extractString, normalizeTitleText } from './session-scanner-values'

// Field readers for Codex's `session_meta` record, whose key spelling has drifted
// across Codex releases (snake_case rollouts, camelCase app-server rollouts).
// Whether the thread is the user's own is read by `session-scanner-codex-non-user-origin.ts`.

export function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
