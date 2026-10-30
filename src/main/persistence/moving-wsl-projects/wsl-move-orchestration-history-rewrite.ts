/**
 * The desktop's orchestration history for a committed WSL move (owner decision 4: rewrite
 * in place, the desktop keeps coordinating). A settled local worker dispatch in a moved project,
 * and its worker-terminal row, take the host's worktree id. Everything else in orchestration.db
 * stays as written; `SQLITE_TABLE_DISPOSITIONS` gives each table's reason.
 */
import { existsSync } from 'node:fs'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import { hardenOrchestrationDatabaseFiles } from '../../runtime/orchestration/db/database-file-permissions'
import Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'
import { wslMoveRewriteScope, type WslMoveRewriteScope } from './wsl-move-rewrite-scope'

export const WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID = 'orchestration-history'

/** The recoverable worker states. The move's dispatch gate must refuse this same set. */
export const WSL_MOVE_LIVE_WORKER_STATES = [
  'starting',
  'ready',
  'start_unknown',
  'stopping',
  'stop_unknown'
] as const

const LIVE_WORKER_STATES_SQL = `(${WSL_MOVE_LIVE_WORKER_STATES.map((state) => `'${state}'`).join(', ')})`

// The lock wait blocks the main thread (synchronous SQLite), so keep it short; a busy pass retries.
const BUSY_TIMEOUT_MS = 2_000

type Rewrite = { key: string; from: string; to: string }

type OrchestrationScope = Pick<WslMoveRewriteScope, 'inScope' | 'worktreeId'>

function text(row: SqliteRow, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

function hasColumns(db: Database, table: string, columns: readonly string[]): boolean {
  const names = new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => text(row, 'name'))
  )
  return columns.every((column) => names.has(column))
}

/** Excludes rows whose dispatch id appears in `table`, when that table exists. */
function unlessListedIn(db: Database, table: string, dispatchIdColumn: string): string {
  return hasColumns(db, table, ['dispatch_id'])
    ? `AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.dispatch_id = ${dispatchIdColumn})`
    : ''
}

/**
 * Rows to rewrite; a structured (chat) worker stays local with its chat (owner decision C). A live
 * row in scope throws, so the store gets no ledger entry and a later pass finds it settled.
 */
function plan(
  rows: SqliteRow[],
  scope: OrchestrationScope,
  keyColumn: string,
  handleColumn: string
): Rewrite[] {
  return rows.flatMap((row) => {
    const key = text(row, keyColumn)
    const from = text(row, 'worktree_id')
    if (!key || !from || isStructuredWorkerHandle(text(row, handleColumn))) {
      return []
    }
    const to = scope.inScope(from) ? scope.worktreeId(from) : from
    if (to === from) {
      return []
    }
    if (row.live === 1) {
      throw new Error('wsl_move_orchestration_worker_live')
    }
    return [{ key, from, to }]
  })
}

function dispatchRewrites(db: Database, scope: OrchestrationScope): Rewrite[] {
  if (
    !hasColumns(db, 'worker_dispatches', [
      'dispatch_id',
      'worktree_id',
      'state',
      'agent_terminal_handle'
    ])
  ) {
    return []
  }
  // A federated dispatch's row names the remote host's worktree.
  const rows = db
    .prepare(
      `SELECT w.dispatch_id, w.worktree_id, w.agent_terminal_handle,
              w.state IN ${LIVE_WORKER_STATES_SQL} AS live
         FROM worker_dispatches w
        WHERE w.worktree_id IS NOT NULL
          ${unlessListedIn(db, 'federated_dispatches', 'w.dispatch_id')}`
    )
    .all()
  return plan(rows, scope, 'dispatch_id', 'agent_terminal_handle')
}

function resourceRewrites(db: Database, scope: OrchestrationScope): Rewrite[] {
  if (
    !hasColumns(db, 'worker_terminal_resources', [
      'id',
      'worktree_id',
      'owner_dispatch_id',
      'terminal_handle'
    ]) ||
    !hasColumns(db, 'worker_dispatches', ['dispatch_id', 'state'])
  ) {
    return []
  }
  // A federated worker's row belongs with its attachment, which a remote home reads verbatim.
  const rows = db
    .prepare(
      `SELECT r.id, r.worktree_id, r.terminal_handle,
              COALESCE(w.state IN ${LIVE_WORKER_STATES_SQL}, 0) AS live
         FROM worker_terminal_resources r
         LEFT JOIN worker_dispatches w ON w.dispatch_id = r.owner_dispatch_id
        WHERE r.worktree_id IS NOT NULL
          ${unlessListedIn(db, 'remote_dispatch_attachments', 'r.owner_dispatch_id')}`
    )
    .all()
  return plan(rows, scope, 'id', 'terminal_handle')
}

// updated_at is left alone: the rewrite must not reorder history.
function applyRewrites(db: Database, sql: string, rewrites: readonly Rewrite[]): number {
  if (rewrites.length === 0) {
    return 0
  }
  const update = db.prepare(sql)
  return rewrites.reduce(
    (changed, row) => changed + Number(update.run(row.to, row.key, row.from).changes),
    0
  )
}

/**
 * Idempotent: a rewritten id is no longer a UNC path of the distro, so a second run finds nothing.
 * One write transaction for both tables, planned before any write. Returns how many rows changed.
 */
export function rewriteWslMoveOrchestrationHistory(
  db: Database,
  scope: OrchestrationScope
): number {
  db.exec('BEGIN IMMEDIATE')
  try {
    const dispatches = dispatchRewrites(db, scope)
    const resources = resourceRewrites(db, scope)
    const changed =
      applyRewrites(
        db,
        `UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ? AND worktree_id = ?`,
        dispatches
      ) +
      applyRewrites(
        db,
        `UPDATE worker_terminal_resources SET worktree_id = ? WHERE id = ? AND worktree_id = ?`,
        resources
      )
    db.exec('COMMIT')
    return changed
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Its own connection, so it runs before the runtime opens the database at startup. It never creates
 * the file or migrates it: a profile with no database has no history, and an older schema is read
 * as it stands.
 */
export function registerWslMoveOrchestrationHistoryStore(databasePath: string): void {
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID,
    side: 'main',
    run: (context) => {
      rewriteWslMoveOrchestrationHistoryFile(databasePath, wslMoveRewriteScope(context))
    },
    // `run` commits with synchronous FULL, so its write is durable before this is called.
    flush: () => {}
  })
}

/** On its own connection, durable when it returns; a missing database has no history. */
export function rewriteWslMoveOrchestrationHistoryFile(
  databasePath: string,
  scope: OrchestrationScope
): void {
  if (!existsSync(databasePath)) {
    return
  }
  const db = new Database(databasePath, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS })
  try {
    // A FULL commit is on disk when it returns, which is what the ledger entry needs.
    db.pragma('synchronous = FULL')
    rewriteWslMoveOrchestrationHistory(db, scope)
  } finally {
    db.close()
    hardenOrchestrationDatabaseFiles(databasePath)
  }
}
