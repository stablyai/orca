import type { OrchestrationDb } from '../orchestration-db'
import { backfillPrincipalColumns } from './principal-column-backfill'

const PRINCIPAL_COLUMNS = [
  ['runs', 'coordinator_principal'],
  ['dispatch_contexts', 'assignee_principal'],
  ['dispatch_contexts', 'creator_principal'],
  ['worker_terminal_resources', 'principal']
] as const

/**
 * Actor principal columns: serialized `OrchestrationPrincipal` alongside every handle/pane-key
 * identity column. Write-only in this version — no read path names them yet. The coordinator
 * mailbox-address cache keeps its shape; a handle-less session coordinator is cached by writing
 * its principal into `terminal_handle`, which is a mailbox-address column, so existing readers
 * match it by plain string equality.
 */
export function migrateV41(this: OrchestrationDb, current: number): void {
  if (current >= 41) {
    return
  }
  // hasColumn guards are mandatory: createTables runs before migrate on every open, so a fresh
  // database already has the columns and an unguarded ALTER would throw duplicate-column.
  for (const [table, column] of PRINCIPAL_COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
  }
  // Sole owner of the COALESCE trigger form. The static createTables SQL keeps the handle-only
  // form because it must stay compilable against a pre-v41 runs table: a database old enough to
  // predate the cache (stamped < 30) would otherwise get triggers naming coordinator_principal
  // before this ALTER runs, and the v40 backfill's INSERT INTO runs dies at prepare. Drop by
  // name — CREATE TRIGGER IF NOT EXISTS never replaces an existing DB's old-predicate triggers.
  // Idempotent under replay, and safe on a fresh DB (recreates the just-created form).
  this.db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_insert;
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_update;
    CREATE TRIGGER trg_runs_remember_coordinator_insert
    AFTER INSERT ON runs
    WHEN NEW.legacy = 0 AND (NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_principal IS NOT NULL)
    BEGIN
      INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
      VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_principal));
    END;
    CREATE TRIGGER trg_runs_remember_coordinator_update
    AFTER UPDATE OF coordinator_handle, coordinator_principal ON runs
    WHEN NEW.legacy = 0 AND (NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_principal IS NOT NULL)
    BEGIN
      INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
      VALUES (NEW.id, COALESCE(NEW.coordinator_handle, NEW.coordinator_principal));
    END;
  `)
  backfillPrincipalColumns(this.db)
}
