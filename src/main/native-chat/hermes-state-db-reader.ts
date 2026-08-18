import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
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

export function readHermesStateDb(dbPath: string, sessionId: string): NativeChatMessage[] | null {
  const db = getDatabase(dbPath)
  if (!db) {
    return null
  }
  try {
    const columns = db.prepare('PRAGMA table_info(messages)').all()
    const names = new Set(columns.map((column) => String(column.name)))
    const optional = (name: string) => (names.has(name) ? name : 'NULL')
    const sessionColumn = names.has('session_id') ? 'session_id' : 'NULL'
    const rows = db
      .prepare(`
      SELECT id, role, content, ${optional('tool_call_id')} AS tool_call_id,
             ${optional('tool_calls')} AS tool_calls, ${optional('tool_name')} AS tool_name,
             ${optional('timestamp')} AS timestamp, ${optional('reasoning')} AS reasoning,
             ${optional('reasoning_content')} AS reasoning_content,
             ${optional('reasoning_details')} AS reasoning_details
        FROM messages
       WHERE ${sessionColumn} = ?
       ORDER BY ${optional('timestamp')} ASC, id ASC
    `)
      .all(sessionId)
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
  } finally {
    db.close()
  }
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
