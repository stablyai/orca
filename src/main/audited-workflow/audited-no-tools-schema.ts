// v10 -> v11: records HOW each audit reached its model.
//
// FULLY ADDITIVE — one nullable column on each of the two run tables, no CHECK
// change anywhere, and therefore no 12-step rebuild. The mode introduces no task
// state and no new table.
//
// NULL MEANS `codex_cli`, and that default is the whole point of making the
// column nullable rather than NOT NULL DEFAULT. Every row written before this
// column existed came from the spawned-CLI path; back-filling them as anything
// else would retroactively relabel real Codex audits as the weaker no-tools mode
// — the exact misrepresentation the mode field exists to prevent. toAuditMode
// owns that reading, so the default lives in one place rather than in a DDL
// clause and a mapper that could drift.
//
// ALTER TABLE ADD COLUMN cannot carry a CHECK, so the narrowing CHECK on
// audit_mode lives in the fresh-DB creation path and every write site uses typed
// literals from AUDIT_MODES — the same rationale as PHASE_3/5/7_TASK_COLUMNS.
import type Database from '../sqlite/sync-database'

/** The run tables that gain a mode column, with the column definition. */
export const PHASE_12_RUN_COLUMNS: readonly [string, string, string][] = [
  ['audited_code_audit_runs', 'audit_mode', 'TEXT'],
  ['audited_plan_review_runs', 'audit_mode', 'TEXT']
]

export function migrateToV11(
  db: Database.Database,
  columnExists: (db: Database.Database, table: string, column: string) => boolean
): void {
  for (const [table, column, type] of PHASE_12_RUN_COLUMNS) {
    // Guarded because this function also runs against a legacy database that may
    // have been partially migrated by an interrupted earlier attempt.
    if (tableExists(db, table) && !columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return row !== undefined
}
