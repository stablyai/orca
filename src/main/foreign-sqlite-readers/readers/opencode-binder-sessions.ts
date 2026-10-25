import { statSync } from 'node:fs'
import { readOpenCodeDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../../opencode-usage/schema-helpers'
import type { BinderSessionRow, OpenCodeSessionCursor } from '../opencode-binder-sessions-result'

/** Composite cursor pagination preserves same-millisecond rows; unknown schemas or absent stores return empty. */
export function readOpenCodeBinderSessions(
  dbPath: string,
  cursor: OpenCodeSessionCursor
): BinderSessionRow[] {
  if (!storeExists(dbPath)) {
    return []
  }
  return readOpenCodeDatabase({
    dbPath,
    read: (db) => {
      // Exclude OpenCode 2 session_v2 rows: its posts already identify the pane and must not bind again.
      const table = 'session'
      if (
        !tableExists(db, table) ||
        !columnExists(db, table, 'directory') ||
        !columnExists(db, table, 'time_created')
      ) {
        return []
      }
      const parent = columnExists(db, table, 'parent_id') ? 'parent_id' : 'NULL'
      const rows: unknown[] = db
        .prepare(
          `SELECT id, directory, time_created, ${parent} AS parent_id FROM ${table} WHERE time_created > ? OR (time_created = ? AND id > ?) ORDER BY time_created ASC, id ASC LIMIT 500`
        )
        .all(cursor.ms, cursor.ms, cursor.id)
      const sessions: BinderSessionRow[] = []
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) {
          continue
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite returns plain row objects; the object check above plus the per-field validation below reject anything else.
        const record = row as Record<string, unknown>
        if (
          typeof record.id !== 'string' ||
          typeof record.directory !== 'string' ||
          typeof record.time_created !== 'number'
        ) {
          continue
        }
        sessions.push({
          id: record.id,
          directory: record.directory,
          createdAtMs: record.time_created,
          parentId: typeof record.parent_id === 'string' ? record.parent_id : null
        })
      }
      return sessions
    }
  })
}

// stat surfaces permission errors that existsSync would confuse with an absent store.
function storeExists(dbPath: string): boolean {
  try {
    statSync(dbPath)
    return true
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err.code === 'ENOENT' || err.code === 'ENOTDIR')
    ) {
      return false
    }
    throw err
  }
}
