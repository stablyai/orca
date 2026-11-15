import SyncDatabase from '../../sqlite/sync-database'
import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import { OPENCODE_SQLITE_BUSY_TIMEOUT_MS } from '../scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'

export type WorkspaceHistorySqliteOutcome = { deleted: string[]; busy: string[] }

// OpenCode, OpenCode 2 and ZCode keep sessions as rows; the session tables are the ones scanners read.
const SESSION_TABLES = ['session', 'session_v2'] as const

/** Delete whole sessions from an agent's database, one short write transaction per session. */
export function deleteWorkspaceHistorySqliteSessions(
  dbPath: string,
  sessionIds: readonly string[]
): WorkspaceHistorySqliteOutcome {
  const outcome: WorkspaceHistorySqliteOutcome = { deleted: [], busy: [] }
  // WSL-share locks are unreliable, so a write there could race the agent inside the distro.
  if (isWslUncPath(dbPath) || sessionIds.length === 0) {
    return { deleted: [], busy: [...sessionIds] }
  }
  let db: SyncDatabase
  let plan: ReturnType<SyncDatabase['prepare']>[]
  try {
    db = new SyncDatabase(dbPath, { fileMustExist: true, timeout: OPENCODE_SQLITE_BUSY_TIMEOUT_MS })
  } catch {
    return { deleted: [], busy: [...sessionIds] }
  }
  try {
    db.pragma('foreign_keys = ON')
    plan = sessionRowPlan(db)
  } catch {
    db.close()
    return { deleted: [], busy: [...sessionIds] }
  }
  try {
    for (const sessionId of sessionIds) {
      try {
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const statement of plan) {
            statement.run(sessionId)
          }
          db.exec('COMMIT')
          outcome.deleted.push(sessionId)
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      } catch {
        outcome.busy.push(sessionId)
      }
    }
  } finally {
    db.close()
  }
  return outcome
}

// Children before parents so databases without ON DELETE CASCADE keep no orphaned rows.
function sessionRowPlan(db: SyncDatabase): ReturnType<SyncDatabase['prepare']>[] {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((row) => row.name)
  const columns = new Map(
    tables.map((table) => [
      table,
      new Set(
        (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
          (column) => column.name
        )
      )
    ])
  )
  const sessionTables = SESSION_TABLES.filter((table) => columns.get(table)?.has('id'))
  if (sessionTables.length === 0) {
    throw new Error('no session table')
  }
  const statements: ReturnType<SyncDatabase['prepare']>[] = []
  for (const [table, names] of columns) {
    if (
      names.has('message_id') &&
      !names.has('session_id') &&
      columns.get('message')?.has('session_id')
    ) {
      statements.push(
        db.prepare(
          `DELETE FROM "${table}" WHERE message_id IN (SELECT id FROM message WHERE session_id = ?)`
        )
      )
    }
  }
  for (const [table, names] of columns) {
    if (names.has('session_id')) {
      statements.push(db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`))
    }
  }
  for (const table of sessionTables) {
    statements.push(db.prepare(`DELETE FROM "${table}" WHERE id = ?`))
  }
  return statements
}
