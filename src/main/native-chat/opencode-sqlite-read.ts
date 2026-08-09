import { existsSync } from 'node:fs'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import SyncDatabase from '../sqlite/sync-database'
import {
  readMappedOpenCodeTail,
  type OpenCodeMessageMapper
} from './opencode-sqlite-paging'

const SQLITE_READ_TIMEOUT_MS = 250
const SQLITE_BUSY_RETRY_COUNT = 2
const SQLITE_BUSY_RETRY_DELAY_MS = 25

export type OpenCodeReadResult =
  | {
      messages: NativeChatMessage[]
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true; retryable?: true }

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    // OpenCode can hold a short write transaction while replacing a streaming part.
    timeout: SQLITE_READ_TIMEOUT_MS
  })
  db.pragma('query_only = ON')
  return db
}

/** Guard the exact schema used by the chat reader before issuing its queries. */
export function canReadOpenCodeChatSession(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'session') &&
    columnExists(db, 'session', 'id') &&
    tableExists(db, 'message') &&
    tableExists(db, 'part') &&
    columnExists(db, 'message', 'id') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'time_created') &&
    columnExists(db, 'message', 'data') &&
    columnExists(db, 'part', 'id') &&
    columnExists(db, 'part', 'message_id') &&
    columnExists(db, 'part', 'time_created') &&
    columnExists(db, 'part', 'data')
  )
}

function openCodeSessionRowExists(db: SyncDatabase, sessionId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM session WHERE id = ? LIMIT 1')
    .get(sessionId) as { found?: number } | undefined
  return row?.found === 1
}

function countSessionMessages(db: SyncDatabase, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM message m WHERE m.session_id = ?')
    .get(sessionId) as { n?: number } | undefined
  return typeof row?.n === 'number' ? row.n : 0
}

function normalizeBeforeOffset(beforeOffset: number | undefined): number | undefined {
  if (beforeOffset === undefined) {
    return undefined
  }
  return Number.isInteger(beforeOffset) && beforeOffset >= 0 ? beforeOffset : 0
}

function sqliteErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export function isRetryableOpenCodeSqliteError(error: unknown): boolean {
  const code = sqliteErrorCode(error)
  if (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_BUSY_SNAPSHOT' ||
    code === 'SQLITE_LOCKED' ||
    code === 'SQLITE_LOCKED_SHAREDCACHE'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /database(?: table)? is locked|database is busy|busy snapshot/i.test(message)
}

function isCorruptOpenCodeSqliteError(error: unknown): boolean {
  const code = sqliteErrorCode(error)
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /not a database|database disk image is malformed|file is encrypted/i.test(message)
}

function waitForOpenCodeSqliteRetry(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SQLITE_BUSY_RETRY_DELAY_MS)
    timer.unref?.()
  })
}

export async function readOpenCodeNativeChatTranscript(
  args: {
    dbPath: string
    sessionId: string
    limit: number
    beforeOffset?: number
  },
  mapMessage: OpenCodeMessageMapper
): Promise<OpenCodeReadResult> {
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 40
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_COUNT; attempt += 1) {
    const result = readOpenCodeTranscriptAttempt({
      ...args,
      limit,
      beforeOffset: normalizeBeforeOffset(args.beforeOffset),
      mapMessage
    })
    if (!('error' in result) || !isRetryableOpenCodeSqliteError(result.error)) {
      return result
    }
    if (attempt === SQLITE_BUSY_RETRY_COUNT) {
      return { ...result, retryable: true }
    }
    await waitForOpenCodeSqliteRetry()
  }
  return { error: 'Transcript unavailable', retryable: true }
}

function readOpenCodeTranscriptAttempt(args: {
  dbPath: string
  sessionId: string
  limit: number
  beforeOffset?: number
  mapMessage: OpenCodeMessageMapper
}): OpenCodeReadResult {
  const { dbPath, sessionId, limit } = args
  let db: SyncDatabase | null = null
  let transactionStarted = false
  try {
    // SyncDatabase's fileMustExist guard throws a plain Error, so check first.
    if (!existsSync(dbPath)) {
      return { error: `SQLite database does not exist: ${dbPath}`, notFound: true }
    }
    db = openReadonlyDatabase(dbPath)
    // Count, message rows, and parts must share one WAL snapshot.
    db.exec('BEGIN')
    transactionStarted = true
    if (!canReadOpenCodeChatSession(db)) {
      return { error: 'Transcript unavailable' }
    }
    if (!openCodeSessionRowExists(db, sessionId)) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const count = countSessionMessages(db, sessionId)
    const requestedOffset = args.beforeOffset === undefined ? count : args.beforeOffset
    const windowEnd = Math.max(0, Math.min(requestedOffset, count))
    if (windowEnd <= 0) {
      return { messages: [], hasMore: false, beforeOffset: 0 }
    }
    return readMappedOpenCodeTail({
      db,
      sessionId,
      windowEnd,
      limit,
      mapMessage: args.mapMessage,
      filterPartsBySessionId: columnExists(db, 'part', 'session_id')
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { error: message, notFound: true }
    }
    if (isRetryableOpenCodeSqliteError(error)) {
      return { error: 'SQLite database is locked' }
    }
    if (isCorruptOpenCodeSqliteError(error)) {
      return { error: 'Transcript unavailable' }
    }
    return { error: message }
  } finally {
    if (transactionStarted && db) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The connection may already have failed while SQLite was recovering.
      }
    }
    try {
      db?.close()
    } catch {
      // Closing a damaged read must not mask the read result.
    }
  }
}
