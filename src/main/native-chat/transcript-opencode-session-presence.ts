import { openOpenCodeDatabaseReadonly } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

/** Whether OpenCode's database holds the session, in either dialect's table; a database with
 *  neither table is a layout this build cannot judge. */
export function readOpenCodeSessionPresence(
  dbPath: string,
  sessionId: string
): 'found' | 'missing' | 'unknown' {
  const db = openOpenCodeDatabaseReadonly(dbPath)
  try {
    const tables = ['session_v2', 'session'].filter(
      (table) => tableExists(db, table) && columnExists(db, table, 'id')
    )
    if (tables.length === 0) {
      return 'unknown'
    }
    return tables.some(
      (table) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(sessionId) != null
    )
      ? 'found'
      : 'missing'
  } finally {
    db.close()
  }
}
