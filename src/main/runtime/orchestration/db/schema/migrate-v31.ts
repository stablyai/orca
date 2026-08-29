import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV31(this: OrchestrationDb, current: number): void {
  if (current >= 31) {
    return
  }
  if (!this.hasColumn('runs', 'coordinator_process_incarnation')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN coordinator_process_incarnation TEXT')
  }
  if (!this.hasColumn('runs', 'coordinator_host_scope')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN coordinator_host_scope TEXT')
  }
  if (!this.hasColumn('runs', 'coordinator_authority_revision')) {
    this.db.exec(
      'ALTER TABLE runs ADD COLUMN coordinator_authority_revision INTEGER NOT NULL DEFAULT -1'
    )
  }
  this.db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runs_clear_stale_coordinator_authority
    AFTER UPDATE OF coordinator_handle, coordinator_pane_key ON runs
    WHEN NEW.coordinator_authority_revision = OLD.coordinator_authority_revision
      AND NOT (
        NEW.coordinator_handle IS OLD.coordinator_handle
        AND NEW.coordinator_pane_key IS OLD.coordinator_pane_key
      )
    BEGIN
      UPDATE runs
      SET coordinator_process_incarnation = NULL, coordinator_host_scope = NULL,
          coordinator_authority_revision = -1
      WHERE id = NEW.id;
    END;
  `)
}
