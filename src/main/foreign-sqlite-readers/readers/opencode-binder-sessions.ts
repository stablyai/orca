import { statSync } from 'node:fs'
import { readOpenCodeDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../../opencode-usage/schema-helpers'
import type { BinderSessionRow, OpenCodeSessionCursor } from '../opencode-binder-sessions-result'

/**
 * Sessions newer than `cursor`, oldest first. The composite `(time_created, id)`
 * position re-lists rows sharing a millisecond with the cursor, including rows
 * the LIMIT cut off last round. Unknown shapes read as empty so an OpenCode
 * schema move degrades to unbound sessions. An absent store is empty (#24577);
 * any other failed open throws, so the client logs it.
 */
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
      // Why `session` only: OpenCode 1 writes it; OpenCode 2 writes `session_v2`, and its
      // posts name their own pane, so its sessions must never bind.
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

// Why stat, not existsSync: a permission failure must surface, not read as an unused store.
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
