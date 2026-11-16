import SyncDatabase from '../../sqlite/sync-database'
import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import { yieldToEventLoop } from '../../../shared/concurrency/event-loop-yield'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import { OPENCODE_SQLITE_BUSY_TIMEOUT_MS } from '../scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'

/** kept: sessions whose ownership no longer held when their turn came. */
export type WorkspaceHistorySqliteOutcome = { deleted: string[]; busy: string[]; kept: string[] }

// OpenCode, OpenCode 2 and ZCode keep sessions as rows; the session tables are the ones scanners read.
const SESSION_TABLES = ['session', 'session_v2'] as const

/** Delete whole sessions from an agent's database, one short write transaction per session. */
export async function deleteWorkspaceHistorySqliteSessions(
  dbPath: string,
  sessionIds: readonly string[],
  inUseSince: number,
  owns: (sessionId: string) => Promise<boolean>,
  signal: AbortSignal
): Promise<WorkspaceHistorySqliteOutcome> {
  // WSL-share locks are unreliable, so a write there could race the agent inside the distro.
  if (isWslUncPath(dbPath) || sessionIds.length === 0) {
    return { deleted: [], busy: [...sessionIds], kept: [] }
  }
  let db: SyncDatabase
  let plan: SessionRowPlan
  try {
    db = new SyncDatabase(dbPath, { fileMustExist: true, timeout: OPENCODE_SQLITE_BUSY_TIMEOUT_MS })
  } catch {
    return { deleted: [], busy: [...sessionIds], kept: [] }
  }
  try {
    // Explicit per-table deletes; cascades would reach child sessions nobody checked.
    db.pragma('foreign_keys = OFF')
    plan = sessionRowPlan(db)
  } catch {
    db.close()
    return { deleted: [], busy: [...sessionIds], kept: [] }
  }
  const outcome: WorkspaceHistorySqliteOutcome = { deleted: [], busy: [], kept: [] }
  try {
    for (const [index, sessionId] of sessionIds.entries()) {
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
      // A long batch outlives the earlier proof: the workspace folder can come back meanwhile.
      if (!(await owns(sessionId))) {
        outcome.kept.push(sessionId)
        continue
      }
      throwIfAiVaultScanCancelled(signal)
      try {
        db.exec('BEGIN IMMEDIATE')
      } catch {
        // The agent holds the write lock; every later session would wait out the same timeout.
        outcome.busy.push(...sessionIds.slice(index))
        break
      }
      try {
        // Under the write lock: a session resumed after the scan is in use now.
        if (
          plan.updatedAt.some(
            (statement) => updatedMs(statement.get(sessionId)?.updated) >= inUseSince
          )
        ) {
          db.exec('ROLLBACK')
          outcome.busy.push(sessionId)
          continue
        }
        for (const statement of plan.deletes) {
          statement.run(sessionId)
        }
        db.exec('COMMIT')
        outcome.deleted.push(sessionId)
      } catch {
        db.exec('ROLLBACK')
        outcome.busy.push(sessionId)
      }
    }
  } finally {
    db.close()
  }
  return outcome
}

// Agents write milliseconds; a seconds value is scaled so it can never look older than it is.
function updatedMs(value: unknown): number {
  const updated = Number(value ?? 0)
  return updated > 0 && updated < 1e12 ? updated * 1000 : updated
}

type SessionRowPlan = {
  updatedAt: ReturnType<SyncDatabase['prepare']>[]
  deletes: ReturnType<SyncDatabase['prepare']>[]
}

// Children before parents so databases without ON DELETE CASCADE keep no orphaned rows.
function sessionRowPlan(db: SyncDatabase): SessionRowPlan {
  const tables = rowNames(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
  const columns = new Map(
    tables.map((table) => [
      table,
      new Set(rowNames(db.prepare(`PRAGMA table_info("${table}")`).all()))
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
  const updatedAt = sessionTables
    .filter((table) => columns.get(table)?.has('time_updated'))
    .map((table) => db.prepare(`SELECT time_updated AS updated FROM "${table}" WHERE id = ?`))
  return { updatedAt, deletes: statements }
}

function rowNames(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) =>
    row && typeof row === 'object' && 'name' in row && typeof row.name === 'string'
      ? [row.name]
      : []
  )
}
