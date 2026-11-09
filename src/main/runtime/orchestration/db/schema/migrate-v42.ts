import type { OrchestrationDb } from '../orchestration-db'

const ORCA_SESSION_ID_COLUMNS = [
  ['runs', 'coordinator_orca_session_id', 'TEXT'],
  ['runs', 'coordinator_orca_session_id_generation', 'INTEGER'],
  ['dispatch_contexts', 'assignee_orca_session_id', 'TEXT'],
  ['dispatch_contexts', 'creator_orca_session_id', 'TEXT']
] as const

/** Store bare /clear-root ids with generation-fenced coordinator identity; on-open backfill/triggers support rollback writers.
 * Earlier dev principal/actor columns are unsupported; skew repair adds current columns and leaves stale ones unread. */
export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  // Fresh databases already got these columns from createTables.
  for (const [table, column, type] of ORCA_SESSION_ID_COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
  // Index session ids so combined pane/session lookups do not scan every Run.
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_coordinator_orca_session_id
      ON runs(coordinator_orca_session_id) WHERE coordinator_orca_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_orca_session_id
      ON dispatch_contexts(assignee_orca_session_id) WHERE assignee_orca_session_id IS NOT NULL;
  `)
}
