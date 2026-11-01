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
import { toolCallContent, transcriptMessageFromText } from './session-transcript-message-content'
import { zcodeVisibleMessageFilter } from './session-scanner-zcode-visibility'
import { zcodeTranscriptOrder } from './session-scanner-zcode-order'
import type SyncDatabase from '../sqlite/sync-database'

// Capture shares session decoding with listing but selects the full transcript instead of the preview window.

const OPENCODE_CAPTURE_PART_TYPES = "('text','reasoning','tool')"

type CaptureRow = {
  messageId: string
  role: string | null
  partType: string
  partData: string
  messageTimeMs: number
}

// Column probes cannot validate row contents; skip unreadable rows without failing the session.
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

/** Combine a tool call and outcome from one part using the text format shared by other providers. */
function toolPartText(partData: string): { text: string; textTruncated: boolean } | null {
  const part = asRecord(parseJson(partData))
  if (!part) {
    return null
  }
  const state = asRecord(part.state)
  const call = toolCallContent(part.tool, sharedToolInputSpelling(state?.input))
  const lines = [call.text, toolOutcome(state)]
  const text = lines.filter((line) => line !== null).join('\n')
  return text.trim() ? { text, textTruncated: call.textTruncated } : null
}

// Prefer failure text over output; running calls can still be indexed by their command alone.
function toolOutcome(state: Record<string, unknown> | null): string | null {
  const error = state?.error
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  const output = state?.output
  return typeof output === 'string' && output.trim() ? output : null
}

// Normalize OpenCode filePath to the shared file_path spelling before formatting tool input.
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

export type OpenCodeSqliteCapture = {
  session: AiVaultSession | null
  messages: TranscriptMessage[]
}

function captureRole(role: string | null): TranscriptMessageRole | null {
  return role === 'user' || role === 'assistant' ? role : null
}

function buildCaptureQuery(db: SyncDatabase, agent: 'opencode' | 'zcode'): string {
  return `SELECT m.id AS message_id,
                 json_extract(m.data, '$.role') AS role,
                 json_extract(p.data, '$.type') AS part_type,
                 p.data AS part_data,
                 m.time_created AS message_time
          FROM message m
          JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ?
            ${zcodeVisibleMessageFilter(agent)}
            AND json_extract(m.data, '$.role') IN ('user','assistant')
            AND json_extract(p.data, '$.type') IN ${OPENCODE_CAPTURE_PART_TYPES}
          ORDER BY ${zcodeTranscriptOrder(db, agent, 'message', 'm', 'ASC')},
                   ${zcodeTranscriptOrder(db, agent, 'part', 'p', 'ASC')}
          LIMIT ?`
}

/** Join each turn’s text/reasoning into one searchable message, followed by separate tool messages. */
export function readOpenCodeSessionMessages(
  db: SyncDatabase,
  sessionId: string,
  agent: 'opencode' | 'zcode' = 'opencode'
): TranscriptMessage[] {
  const agentName = agent === 'zcode' ? 'ZCode' : 'OpenCode'
  if (!canReadOpenCodeMessageParts(db)) {
    // Empty success would advance the search cursor permanently; schema failures must remain retryable.
    throw new Error(
      `${agentName} session ${sessionId} uses an unreadable message-part schema; its transcript was not read.`
    )
  }
  const rows = db
    .prepare(buildCaptureQuery(db, agent))
    .all(sessionId, OPENCODE_CAPTURE_RECORD_LIMIT + 1)
  if (rows.length > OPENCODE_CAPTURE_RECORD_LIMIT) {
    throw new Error(
      `${agentName} session ${sessionId} holds more than ${OPENCODE_CAPTURE_RECORD_LIMIT} text parts; its transcript was not read.`
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
        `${agentName} session ${sessionId} decodes to more than ${OPENCODE_CAPTURE_TEXT_LIMIT} characters; its transcript was not read.`
      )
    }
    messages.push(message)
  }

  // Match file-provider decoding order: turn text first, then tools.
  const flush = (): void => {
    const message =
      openRole && openWords.length > 0
        ? transcriptMessageFromText(openRole, openWords.join('\n'), openTimestamp)
        : null
    if (message) {
      keep(message)
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
      const content = toolPartText(row.partData)
      const message = content
        ? transcriptMessageFromText('tool', content.text, openTimestamp, content.textTruncated)
        : null
      if (message) {
        openTools.push(message)
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

/** Read session metadata and the full transcript through one database connection. */
export async function captureOpenCodeSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  agent?: 'opencode' | 'zcode'
}): Promise<OpenCodeSqliteCapture> {
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => {
      const session = readOpenCodeSqliteSession({ db, ...args })
      return {
        session,
        messages: session ? readOpenCodeSessionMessages(db, args.sessionId, args.agent) : []
      }
    }
  })
}
