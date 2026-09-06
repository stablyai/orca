import type SyncDatabase from '../sqlite/sync-database'
import { captureIndexableText, toolCallText } from './session-search-content'
import { isSessionSearchCaptureActive } from './session-search-capture'

/** The preview ring is deliberately small; search consumes every part once. */
export function captureOpenCodeSession(db: SyncDatabase, sessionId: string): void {
  if (!isSessionSearchCaptureActive()) {
    return
  }
  const rows = db
    .prepare(`SELECT json_extract(m.data, '$.role') AS role,
    p.data AS data, p.time_created AS ts FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.time_created, p.id`)
    .iterate(sessionId)
  for (const row of rows) {
    const part = JSON.parse(String(row.data)) as {
      type?: string
      text?: string
      tool?: string
      state?: { input?: unknown; output?: string }
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      captureIndexableText(row.role === 'user' ? 'user' : 'assistant', part.text, row.ts)
    } else if (part.type === 'tool') {
      captureIndexableText('tool', toolCallText(part.tool, part.state?.input), row.ts)
      if (typeof part.state?.output === 'string') {
        captureIndexableText('tool', part.state.output, row.ts)
      }
    }
  }
}
