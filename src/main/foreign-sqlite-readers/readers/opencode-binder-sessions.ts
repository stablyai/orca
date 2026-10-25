import { statSync } from 'node:fs'
import { readOpenCodeDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../../opencode-usage/schema-helpers'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'
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
        if (!isRecord(row)) {
          continue
        }
        if (
          typeof row.id !== 'string' ||
          typeof row.directory !== 'string' ||
          typeof row.time_created !== 'number'
        ) {
          continue
        }
        sessions.push({
          id: row.id,
          directory: row.directory,
          createdAtMs: row.time_created,
          parentId: typeof row.parent_id === 'string' ? row.parent_id : null
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
