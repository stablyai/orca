import {
  OPENCODE_CAPTURE_RECORD_LIMIT,
  OPENCODE_CAPTURE_TEXT_LIMIT
} from './opencode-transcript-capture-limits'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { timestampIso } from './session-scanner-accumulator'
import { asRecord } from './session-scanner-record-value'
import { extractPartText, readOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import { readOpenCodeDatabase } from './session-scanner-opencode-sqlite-open'
import { canReadOpenCodeMessageParts } from './session-scanner-opencode-sqlite-schema'
import type { TranscriptMessage, TranscriptMessageRole } from './session-transcript-consumers'
import { boundedText, toolCallText } from './session-transcript-message-content'
import type SyncDatabase from '../sqlite/sync-database'

// Why: the session list needs the newest few messages, and the search index
// needs every one of them. That is the only difference between this read and
// `parseOpenCodeSqliteSession`, so the decoding is shared and only the query
// that selects the rows differs.

/** The part types that carry something a person would search for. */
const OPENCODE_CAPTURE_PART_TYPES = "('text','reasoning','tool')"

type CaptureRow = {
  messageId: string
  role: string | null
  partType: string
  partData: string
  messageTimeMs: number
}

// A row this build cannot read is dropped rather than failing the session: the
// schema probe only proves the columns exist, not what any one row holds.
function toCaptureRow(value: unknown): CaptureRow | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const {
    message_id: messageId,
    role,
    part_type: partType,
    part_data: partData,
    message_time: messageTime
  } = record
  if (
    typeof messageId !== 'string' ||
    typeof partType !== 'string' ||
    typeof partData !== 'string' ||
    typeof messageTime !== 'number'
  ) {
    return null
  }
  return {
    messageId,
    role: typeof role === 'string' ? role : null,
    partType,
    partData,
    messageTimeMs: messageTime
  }
}

/**
 * One tool call as the text a consumer sees: what was run, then what came back.
 *
 * Both halves live on one `part` here, where a file provider writes a
 * `tool_use` block and a matching `tool_result`, so this is one message where
 * those are two. The wording of each half is the shared one on purpose: a
 * search for a command should find it whichever agent ran it.
 */
function toolPartText(partData: string): string | null {
  const part = asRecord(parseJson(partData))
  if (!part) {
    return null
  }
  const state = asRecord(part.state)
  const lines = [toolCallText(part.tool, sharedToolInputSpelling(state?.input)), toolOutcome(state)]
  const text = lines.filter((line) => line !== null).join('\n')
  return text.trim() ? text : null
}

// `state.error` is set on a failed or cancelled call and `state.output` on a
// completed one; a call still running has neither, and its command line alone is
// worth indexing. Preferring the error matches what the session actually shows.
function toolOutcome(state: Record<string, unknown> | null): string | null {
  const error = state?.error
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  const output = state?.output
  return typeof output === 'string' && output.trim() ? output : null
}

// OpenCode spells its file argument `filePath`; every other provider, and so the
// shared key list, spells it `file_path`. Renaming the one key here keeps a
// single list rather than teaching it one provider's casing.
function sharedToolInputSpelling(input: unknown): unknown {
  const record = asRecord(input)
  if (!record || typeof record.filePath !== 'string' || typeof record.file_path === 'string') {
    return input
  }
  return { ...record, file_path: record.filePath }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** The session the panel renders, and every message the index folds. */
export type OpenCodeSqliteCapture = {
  session: AiVaultSession | null
  messages: TranscriptMessage[]
}

function captureRole(role: string | null): TranscriptMessageRole | null {
  return role === 'user' || role === 'assistant' ? role : null
}

function buildCaptureQuery(): string {
  // Message order, then part order within a message: the same key the preview
  // read uses, run forwards and without the newest-N window.
  return `SELECT m.id AS message_id,
                 json_extract(m.data, '$.role') AS role,
                 json_extract(p.data, '$.type') AS part_type,
                 p.data AS part_data,
                 m.time_created AS message_time
          FROM message m
          JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ?
            AND json_extract(m.data, '$.role') IN ('user','assistant')
            AND json_extract(p.data, '$.type') IN ${OPENCODE_CAPTURE_PART_TYPES}
          ORDER BY m.time_created ASC, m.id ASC, p.time_created ASC, p.rowid ASC
          LIMIT ?`
}

/**
 * Decode one session's whole transcript.
 *
 * A turn's `text` and `reasoning` parts become one message, the way every other
 * provider hands a consumer one message per turn, so a phrase that runs across
 * two blocks of the same turn is still one indexable row. Reasoning folds into
 * that text because the shared block list already treats a thinking block as the
 * turn's own words. Each `tool` part is its own `tool` message, and they follow
 * the turn's words in transcript order -- the ordering a content-block decode
 * produces for every file provider.
 */
export function readOpenCodeSessionMessages(
  db: SyncDatabase,
  sessionId: string
): TranscriptMessage[] {
  if (!canReadOpenCodeMessageParts(db)) {
    // Thrown for the same reason the part limit below throws: an empty capture
    // returned here is committed under a complete-read cursor, so the session
    // stays out of search with nothing on its row to say why and no retry.
    throw new Error(
      `OpenCode session ${sessionId} uses an unreadable message-part schema; its transcript was not read.`
    )
  }
  const rows = db.prepare(buildCaptureQuery()).all(sessionId, OPENCODE_CAPTURE_RECORD_LIMIT + 1)
  if (rows.length > OPENCODE_CAPTURE_RECORD_LIMIT) {
    throw new Error(
      `OpenCode session ${sessionId} holds more than ${OPENCODE_CAPTURE_RECORD_LIMIT} text parts; its transcript was not read.`
    )
  }

  const messages: TranscriptMessage[] = []
  let captured = 0
  let openMessageId: string | null = null
  let openWords: string[] = []
  let openTools: TranscriptMessage[] = []
  let openRole: TranscriptMessageRole | null = null
  let openTimestamp: string | null = null

  const keep = (message: TranscriptMessage): void => {
    captured += message.text.length
    if (captured > OPENCODE_CAPTURE_TEXT_LIMIT) {
      throw new Error(
        `OpenCode session ${sessionId} decodes to more than ${OPENCODE_CAPTURE_TEXT_LIMIT} characters; its transcript was not read.`
      )
    }
    messages.push(message)
  }

  // The turn's own words lead, its tool calls follow: the order
  // `transcriptMessagesFromContent` produces for a file provider's blocks.
  const flush = (): void => {
    const text = openRole && openWords.length > 0 ? boundedText(openWords.join('\n')) : null
    if (openRole && text) {
      keep({ role: openRole, text, timestamp: openTimestamp })
    }
    for (const tool of openTools) {
      keep(tool)
    }
    openWords = []
    openTools = []
  }

  for (const value of rows) {
    const row = toCaptureRow(value)
    if (!row) {
      continue
    }
    if (row.messageId !== openMessageId) {
      flush()
      openMessageId = row.messageId
      openRole = captureRole(row.role)
      openTimestamp = timestampIso(row.messageTimeMs)
    }
    if (row.partType === 'tool') {
      const text = boundedText(toolPartText(row.partData) ?? '')
      if (text) {
        openTools.push({ role: 'tool', text, timestamp: openTimestamp })
      }
      continue
    }
    const text = extractPartText(row.partData)
    if (text) {
      openWords.push(text)
    }
  }
  flush()
  return messages
}

/**
 * Read one OpenCode session and its whole transcript from a single open of the
 * database, so the two can never describe different generations of the session.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - Primary key in the `session` table.
 * @param args.platform - Platform used for resume-command generation.
 * @returns The parsed session (null when it does not exist) and its messages.
 */
export async function captureOpenCodeSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): Promise<OpenCodeSqliteCapture> {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => {
      const session = readOpenCodeSqliteSession({ db, ...args })
      // No session row is no transcript: the id names nothing in this database.
      return { session, messages: session ? readOpenCodeSessionMessages(db, args.sessionId) : [] }
    }
  })
}
