import type { OrchestrationDb } from '../orchestration-db'

export const RUN_AUTHORITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS run_authority (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    creating_dispatch_id TEXT,
    creating_task_id TEXT,
    parent_run_id TEXT,
    creating_home_peer TEXT,
    owner_task_id TEXT,
    owner_home_peer TEXT,
    last_handle TEXT,
    last_pane_key TEXT,
    last_session_id TEXT,
    last_process_incarnation TEXT
  );
  CREATE TABLE IF NOT EXISTS run_handovers (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    grantor_key TEXT NOT NULL,
    target_task_id TEXT,
    target_caller_key TEXT,
    expires_at INTEGER NOT NULL,
    CHECK ((target_task_id IS NULL) != (target_caller_key IS NULL))
  );
`

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (
    current >= 44 &&
    this.hasColumn('run_authority', 'last_process_incarnation') &&
    this.hasColumn('run_handovers', 'target_caller_key')
  ) {
    return
  }
  this.db.exec(RUN_AUTHORITY_SCHEMA_SQL)
  this.db.exec(`
    INSERT OR IGNORE INTO run_authority (run_id, last_handle, last_pane_key, last_session_id)
    SELECT id, coordinator_handle, coordinator_pane_key,
      CASE WHEN coordinator_orca_session_id_generation = consumer_generation
        THEN coordinator_orca_session_id END
    FROM runs WHERE legacy = 0;
  `)
}

// Unknown seat writers retain only facts they supplied; they cannot inherit process proof.
export function createRunAuthorityTriggers(db: OrchestrationDb['db']): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_run_authority_insert AFTER INSERT ON runs
    WHEN NEW.legacy = 0 BEGIN
      INSERT OR IGNORE INTO run_authority (run_id, last_handle, last_pane_key, last_session_id)
      VALUES (NEW.id, NEW.coordinator_handle, NEW.coordinator_pane_key,
        CASE WHEN NEW.coordinator_orca_session_id_generation = NEW.consumer_generation
          THEN NEW.coordinator_orca_session_id END);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_run_authority_update
    AFTER UPDATE OF coordinator_handle, coordinator_pane_key, coordinator_orca_session_id,
      coordinator_orca_session_id_generation, consumer_generation ON runs
    WHEN NEW.legacy = 0 AND (NEW.coordinator_pane_key IS NOT NULL
      OR NEW.coordinator_orca_session_id IS NOT NULL) BEGIN
      DELETE FROM run_handovers WHERE run_id = NEW.id AND NOT EXISTS (
        SELECT 1 FROM run_authority WHERE run_id = NEW.id
          AND last_session_id IS NOT NULL AND last_session_id = NEW.coordinator_orca_session_id
          AND NEW.coordinator_orca_session_id_generation = NEW.consumer_generation
      );
      UPDATE run_authority SET last_handle = NEW.coordinator_handle,
        last_pane_key = NEW.coordinator_pane_key,
        last_session_id = CASE
          WHEN NEW.coordinator_orca_session_id_generation = NEW.consumer_generation
          THEN NEW.coordinator_orca_session_id END,
        last_process_incarnation = NULL WHERE run_id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_run_authority_delete AFTER DELETE ON runs BEGIN
      DELETE FROM run_handovers WHERE run_id = OLD.id;
      DELETE FROM run_authority WHERE run_id = OLD.id;
    END;
  `)
}
