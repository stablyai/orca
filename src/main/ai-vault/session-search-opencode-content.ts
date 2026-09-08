import type SyncDatabase from '../sqlite/sync-database'
import { captureIndexableText, toolCallText } from './session-search-content'
import { canReadOpenCodeMessageParts } from './session-scanner-opencode-sqlite-schema'
import {
  checkpointSessionSearchCapture,
  isSessionSearchCaptureActive,
  markSessionSearchCaptureIncomplete
} from './session-search-capture'

const SESSION_PARTS_SQL = `SELECT json_extract(m.data, '$.role') AS role,
    p.data AS data, p.time_created AS ts FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.time_created, p.id`

type OpenCodePartRow = {
  role: unknown
  part: {
    type?: string
    text?: string
    tool?: string
    state?: { input?: unknown; output?: string }
  }
  ts: unknown
}

function decodePart(data: unknown): OpenCodePartRow['part'] | null {
  try {
    const parsed = JSON.parse(String(data)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as OpenCodePartRow['part'])
      : null
  } catch {
    return null
  }
}

/**
 * Yield every decodable part of one session.
 *
 * A read failure ends the stream instead of throwing: search coverage degrades
 * to no rows for this session, which must never cost the session its place in
 * the list. It does mark the capture incomplete, because rows this short must
 * never publish a file cursor that would retire the session from every later
 * scan. Consumer-thrown cancellation resumes the generator with a `return`
 * completion, so it never reaches the catch and still propagates to the caller.
 */
function* readOpenCodeSessionParts(
  db: SyncDatabase,
  sessionId: string
): Generator<OpenCodePartRow> {
  try {
    for (const row of db.prepare(SESSION_PARTS_SQL).iterate(sessionId)) {
      const part = decodePart(row.data)
      if (part) {
        yield { role: row.role, part, ts: row.ts }
      }
    }
  } catch (error) {
    markSessionSearchCaptureIncomplete()
    console.warn(
      '[ai-vault] opencode search capture skipped',
      error instanceof Error ? error.name : 'ReadError'
    )
  }
}

/** The preview ring is deliberately small; search consumes every part once. */
export async function captureOpenCodeSession(db: SyncDatabase, sessionId: string): Promise<void> {
  if (!isSessionSearchCaptureActive() || !canReadOpenCodeMessageParts(db)) {
    return
  }
  for (const { role, part, ts } of readOpenCodeSessionParts(db, sessionId)) {
    if (part.type === 'text' && typeof part.text === 'string') {
      captureIndexableText(role === 'user' ? 'user' : 'assistant', part.text, ts)
    } else if (part.type === 'tool') {
      captureIndexableText('tool', toolCallText(part.tool, part.state?.input), ts)
      if (typeof part.state?.output === 'string') {
        captureIndexableText('tool', part.state.output, ts)
      }
    }
    await checkpointSessionSearchCapture()
  }
}
