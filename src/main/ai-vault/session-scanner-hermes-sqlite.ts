import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSessionPreviewMessage
} from '../../shared/ai-vault-types'
import type SyncDatabase from '../sqlite/sync-database'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import {
  openCodeDatabaseScanIssue,
  readOpenCodeDatabase
} from './session-scanner-opencode-sqlite-open'
import { scopedSessionRows } from './session-scanner-sqlite-scope-rows'
import { addSessionContent } from './session-scanner-messages'
import {
  extractFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'
import {
  OPENCODE_CAPTURE_RECORD_LIMIT,
  OPENCODE_CAPTURE_TEXT_LIMIT
} from './opencode-transcript-capture-limits'
import { asRecord, extractContentText } from './session-scanner-values'
import type { SessionAccumulator, SessionFileCandidate } from './session-scanner-types'
import type { TranscriptMessage, TranscriptMessageSink } from './session-transcript-consumers'
import {
  sessionRow,
  sessionColumns,
  canReadMessages,
  visibility,
  messagePredicate,
  sessionVisibility,
  messageQuery,
  timestampMs,
  type SessionRow
} from './session-scanner-hermes-sqlite-schema'

type ReadArgs = { dbPath: string; sessionId: string; platform: NodeJS.Platform }
const PREVIEW_LIMIT = 5

function rowCandidate(row: SessionRow, dbPath: string): SessionFileCandidate {
  return {
    agent: 'hermes',
    codexHome: null,
    file: {
      path: buildHermesSqliteCandidatePath(dbPath, row.id),
      mtimeMs: row.updatedAt,
      modifiedAt: new Date(row.updatedAt).toISOString()
    }
  }
}

export async function listHermesSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
}): Promise<SessionFileCandidate[]> {
  const candidates: SessionFileCandidate[] = []
  if (args.limit <= 0) {
    return candidates
  }
  for (const dbPath of new Set(args.dbPaths)) {
    try {
      const rows = readOpenCodeDatabase({
        dbPath,
        read: (db) => {
          const columns = sessionColumns(db)
          if (!columns || !canReadMessages(db)) {
            return []
          }
          const scoped = Boolean(args.scopePaths?.length)
          const limited = Number.isFinite(args.limit) && !scoped
          const statement = db.prepare(`SELECT ${columns.select} FROM sessions
          WHERE 1=1 ${sessionVisibility(db)} AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.${columns.id} ${visibility(db, 'm')})
          ORDER BY ${columns.updated} DESC ${limited ? 'LIMIT ?' : ''}`)
          const values = limited ? statement.iterate(Math.floor(args.limit)) : statement.iterate()
          function* checked(): Generator<SessionRow> {
            for (const value of values) {
              const row = sessionRow(value)
              if (row) {
                yield row
              }
            }
          }
          return scoped && args.scopePaths
            ? scopedSessionRows(checked(), args.scopePaths, args.limit, dbPath)
            : Array.from(checked())
        }
      })
      for (const row of rows) {
        candidates.push(rowCandidate(row, dbPath))
      }
    } catch (error) {
      args.issues.push(openCodeDatabaseScanIssue(dbPath, error, 'hermes'))
    }
  }
  return candidates.sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
}

export function listHermesSqliteSessionIds(
  dbPaths: readonly string[],
  sessionIds: readonly string[]
): string[] {
  const represented = new Set<string>()
  const requested = [...new Set(sessionIds)]
  if (!requested.length) {
    return []
  }
  for (const dbPath of new Set(dbPaths)) {
    try {
      readOpenCodeDatabase({
        dbPath,
        read: (db) => {
          const columns = sessionColumns(db)
          if (!columns || !canReadMessages(db)) {
            return
          }
          for (let offset = 0; offset < requested.length; offset += 500) {
            const chunk = requested.slice(offset, offset + 500)
            const rows = db
              .prepare(`SELECT ${columns.id} AS id FROM sessions
            WHERE ${columns.id} IN (${chunk.map(() => '?').join(',')})
              AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.${columns.id})`)
              .all(...chunk)
            for (const value of rows) {
              const id = asRecord(value)?.id
              if (typeof id === 'string') {
                represented.add(id)
              }
            }
          }
        }
      })
    } catch {
      // Discovery reports unreadable stores; keep their legacy fallback available.
    }
  }
  return [...represented]
}

function contentValue(value: unknown, truncated = false): unknown {
  if (typeof value !== 'string' || !value.startsWith('\0json:')) {
    return value
  }
  try {
    return JSON.parse(value.slice(6))
  } catch {
    return truncated ? null : value
  }
}

function messageRole(value: unknown): AiVaultSessionPreviewMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool'
    ? value
    : 'unknown'
}

function toolBlocks(value: unknown): unknown[] {
  if (typeof value !== 'string') {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed.flatMap((item) => {
    const call = asRecord(item)
    const fn = asRecord(call?.function)
    if (!fn) {
      return []
    }
    let input: unknown = fn.arguments
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        /* Keep malformed arguments as text. */
      }
    }
    return [{ type: 'tool_use', name: fn.name, input }]
  })
}

function consumeMessage(accumulator: SessionAccumulator, value: unknown): void {
  const row = asRecord(value)
  if (!row) {
    return
  }
  const content = contentValue(row.content, row.content_truncated === 1)
  accumulator.previewMessagesTruncated ||= row.content_truncated === 1
  const blocks = Array.isArray(content) ? [...content] : content == null ? [] : [content]
  if (accumulator.messages.active) {
    blocks.push(...toolBlocks(row.tool_calls))
  }
  addSessionContent(
    accumulator,
    messageRole(row.role),
    blocks,
    timestampMs(row.timestamp) || undefined,
    { seedFirstUserPrompt: false }
  )
}

function readSession(
  db: SyncDatabase,
  args: ReadArgs,
  sink?: TranscriptMessageSink
): AiVaultSession | null {
  const columns = sessionColumns(db)
  if (!columns) {
    return null
  }
  const row = sessionRow(
    db
      .prepare(`SELECT ${columns.select} FROM sessions WHERE ${columns.id} = ? LIMIT 1`)
      .get(args.sessionId)
  )
  if (!row || row.id !== args.sessionId) {
    return null
  }
  if (!canReadMessages(db)) {
    throw new Error('Hermes message schema could not be read.')
  }
  const accumulator = createAccumulator({
    agent: 'hermes',
    file: rowCandidate(row, args.dbPath).file,
    sessionId: row.id,
    messages: sink
  })
  accumulator.title = row.title
  accumulator.cwd = row.directory
  accumulator.model = row.model
  updateTimeline(accumulator, row.createdAt)
  updateTimeline(accumulator, row.updatedAt)
  const count = asRecord(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages m WHERE m.session_id = ? ${messagePredicate(db)} AND m.role IN ('user','assistant')`
      )
      .get(row.id)
  )
  accumulator.messageCount = typeof count?.count === 'number' ? count.count : 0
  const first = asRecord(
    db.prepare(messageQuery(db, shouldCaptureFullFirstUserPrompt(), true)).get(row.id, 1)
  )
  if (!accumulator.title && first) {
    accumulator.title = extractContentText(
      contentValue(first.content, first.content_truncated === 1)
    )
  }
  if (shouldCaptureFullFirstUserPrompt() && first) {
    accumulator.firstUserPrompt = extractFullFirstUserPromptText(
      contentValue(first.content, first.content_truncated === 1)
    )
  }
  const values = db
    .prepare(messageQuery(db, Boolean(sink?.active)))
    .iterate(row.id, sink?.active ? OPENCODE_CAPTURE_RECORD_LIMIT + 1 : PREVIEW_LIMIT + 1)
  if (sink?.active) {
    let records = 0
    for (const value of values) {
      if (++records > OPENCODE_CAPTURE_RECORD_LIMIT) {
        throw new Error('Hermes transcript exceeds the capture record limit.')
      }
      consumeMessage(accumulator, value)
    }
  } else {
    const previews = Array.from(values)
    accumulator.previewMessagesTruncated = previews.length > PREVIEW_LIMIT
    for (const value of previews.slice(0, PREVIEW_LIMIT).toReversed()) {
      consumeMessage(accumulator, value)
    }
  }
  return finalizeSession(accumulator, args.platform)
}

export async function parseHermesSqliteSession(args: ReadArgs): Promise<AiVaultSession | null> {
  return readOpenCodeDatabase({ dbPath: args.dbPath, read: (db) => readSession(db, args) })
}

export async function captureHermesSqliteSession(
  args: ReadArgs
): Promise<{ session: AiVaultSession | null; messages: TranscriptMessage[] }> {
  const messages: TranscriptMessage[] = []
  let textLength = 0
  const sink: TranscriptMessageSink = {
    active: true,
    push(message) {
      textLength += message.text.length
      if (textLength > OPENCODE_CAPTURE_TEXT_LIMIT) {
        throw new Error('Hermes transcript exceeds the capture text limit.')
      }
      messages.push(message)
    }
  }
  return readOpenCodeDatabase({
    dbPath: args.dbPath,
    read: (db) => ({ session: readSession(db, args, sink), messages })
  })
}
