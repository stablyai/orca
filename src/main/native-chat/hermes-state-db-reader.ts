import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { decodeHermesDatabaseMessage } from './transcript-line-decoders-hermes'

const requireOptional = createRequire(__filename)

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[]
  get: (...args: unknown[]) => Record<string, unknown> | undefined
}
type SqliteDatabase = { prepare: (sql: string) => SqliteStatement; close: () => void }
type DatabaseConstructor = new (
  path: string,
  options?: { readOnly?: boolean; fileMustExist?: boolean; timeout?: number }
) => SqliteDatabase

type HermesDbPage = {
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
  /** Highest row id visible in this read; used as the live-watch cursor. */
  nextOffset: number
}

function getDatabase(path: string): SqliteDatabase | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const Database = (requireOptional('node:sqlite') as { DatabaseSync?: DatabaseConstructor })
      .DatabaseSync
    return Database ? new Database(path, { readOnly: true, fileMustExist: true }) : null
  } catch {
    return null
  }
}

function messageColumns(db: SqliteDatabase): Set<string> {
  return new Set(
    db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((column) => String(column.name))
  )
}

function optionalColumn(columns: Set<string>, name: string): string {
  return columns.has(name) ? name : 'NULL'
}

function selectMessageRows(
  db: SqliteDatabase,
  columns: Set<string>,
  id: string,
  where: string,
  order: 'ASC' | 'DESC',
  params: unknown[],
  limit: number
): Record<string, unknown>[] {
  return db
    .prepare(`
      SELECT ${id} AS id,
             role,
             content,
             ${optionalColumn(columns, 'tool_call_id')} AS tool_call_id,
             ${optionalColumn(columns, 'tool_calls')} AS tool_calls,
             ${optionalColumn(columns, 'tool_name')} AS tool_name,
             ${optionalColumn(columns, 'timestamp')} AS timestamp,
             ${optionalColumn(columns, 'reasoning')} AS reasoning,
             ${optionalColumn(columns, 'reasoning_content')} AS reasoning_content,
             ${optionalColumn(columns, 'reasoning_details')} AS reasoning_details
        FROM messages
       WHERE ${where}
       ORDER BY ${id} ${order}
       LIMIT ?
    `)
    .all(...params, limit)
}

function decodeHermesRows(rows: Record<string, unknown>[], sessionId: string): NativeChatMessage[] {
  return rows.flatMap((row, index) => {
    const message = decodeHermesDatabaseMessage(row, `${sessionId}:${index}`)
    return message
      ? [
          {
            ...message,
            timestamp: typeof row.timestamp === 'number' ? row.timestamp * 1000 : null
          }
        ]
      : []
  })
}

export function readHermesStateDbPage(
  dbPath: string,
  sessionId: string,
  limit: number,
  beforeOffset?: number
): HermesDbPage | null {
  const db = getDatabase(dbPath)
  if (!db) {
    return null
  }
  try {
    const columns = messageColumns(db)
    if (!columns.has('session_id')) {
      return { messages: [], hasMore: false, beforeOffset: 0, nextOffset: 0 }
    }
    const id = columns.has('id') ? 'id' : 'rowid'
    const activityClause = columns.has('active') ? ' AND active = 1' : ''
    const pageSize = Math.max(0, limit)
    const cursor = beforeOffset === undefined ? null : beforeOffset
    const rows = selectMessageRows(
      db,
      columns,
      id,
      `session_id = ?${activityClause} AND (? IS NULL OR ${id} < ?)`,
      'DESC',
      [sessionId, cursor, cursor],
      pageSize + 1
    )
    const pageRows = rows.slice(0, pageSize).toReversed()
    return {
      messages: decodeHermesRows(pageRows, sessionId),
      hasMore: rows.length > pageSize,
      beforeOffset: pageRows.length ? Number(pageRows[0]?.id) : 0,
      nextOffset: rows.length ? Number(rows[0]?.id) : 0
    }
  } finally {
    db.close()
  }
}

export function readHermesStateDbAppends(
  dbPath: string,
  sessionId: string,
  afterOffset: number,
  limit: number
): { messages: NativeChatMessage[]; nextOffset: number } | null {
  const db = getDatabase(dbPath)
  if (!db) {
    return null
  }
  try {
    const columns = messageColumns(db)
    if (!columns.has('session_id')) {
      return { messages: [], nextOffset: afterOffset }
    }
    const id = columns.has('id') ? 'id' : 'rowid'
    const activityClause = columns.has('active') ? ' AND active = 1' : ''
    const pageSize = Math.max(1, limit)
    const rows = selectMessageRows(
      db,
      columns,
      id,
      `session_id = ?${activityClause} AND ${id} > ?`,
      'ASC',
      [sessionId, afterOffset],
      pageSize + 1
    )
    const pageRows = rows.slice(0, pageSize)
    return {
      messages: decodeHermesRows(pageRows, sessionId),
      nextOffset: pageRows.length ? Number(pageRows.at(-1)?.id) : afterOffset
    }
  } finally {
    db.close()
  }
}

export function readHermesStateDb(dbPath: string, sessionId: string): NativeChatMessage[] | null {
  const page = readHermesStateDbPage(dbPath, sessionId, Number.MAX_SAFE_INTEGER)
  return page?.messages ?? null
}

export function hasHermesSession(dbPath: string, sessionId: string): boolean {
  const db = getDatabase(dbPath)
  if (!db) {
    return false
  }
  try {
    return Boolean(
      db.prepare('SELECT 1 AS present FROM sessions WHERE id = ? LIMIT 1').get(sessionId)
    )
  } finally {
    db.close()
  }
}

export type { HermesDbPage }
