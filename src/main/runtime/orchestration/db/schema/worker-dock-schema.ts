import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { randomUUID } from 'node:crypto'
import type { OrchestrationDb } from '../orchestration-db'

// The projection is written inside the existing lifecycle/report transaction, before its wake.
const projection = (identity: string) => `
  INSERT INTO worker_dock_facts(dispatch_id, source, home, state, changed_at, report_id, settlement, model, reason)
  SELECT d.id, COALESCE(d.creator_orca_session_id, CASE WHEN d.creator_dispatch_id IS NULL THEN r.coordinator_orca_session_id END),
    CASE WHEN r.home_database = 'this_database' THEN (SELECT id FROM worker_dock_authority LIMIT 1) ELSE r.home_database END, w.state,
    COALESCE(f.home_received_at, CAST(round(unixepoch(w.updated_at, 'subsec') * 1000) AS INTEGER)),
    CASE WHEN f.facet = 'worker_report' AND json_extract(f.payload, '$.status') = 'accepted'
      AND EXISTS(SELECT 1 FROM messages m WHERE m.id = substr(f.id, 15))
      THEN substr(f.id, 15) END,
    CASE WHEN w.state IN ('failed', 'stopped', 'abandoned')
      THEN COALESCE(f.id, w.state || ':' || w.updated_at) END,
    CASE WHEN json_valid(w.start_options) AND json_type(w.start_options, '$.launch.effective.model') = 'text' THEN json_extract(w.start_options, '$.launch.effective.model') END,
    substr(COALESCE((SELECT body FROM messages WHERE id = substr(f.id, 15) AND w.state = 'failed'), w.last_error, d.last_failure), 1, 512)
  FROM worker_dispatches w
  JOIN dispatch_contexts d ON d.id = w.dispatch_id
  JOIN runs r ON r.id = d.run_id
  LEFT JOIN attempt_observation_facts f ON f.id = (
    SELECT id FROM attempt_observation_facts WHERE dispatch_id = d.id AND facet = 'worker_report'
      AND json_extract(payload, '$.status') = 'accepted' ORDER BY sequence DESC LIMIT 1)
  WHERE d.id = ${identity}
  ON CONFLICT(dispatch_id) DO UPDATE SET source = excluded.source, home = excluded.home,
    state = excluded.state,
    changed_at = CASE WHEN worker_dock_facts.state <> excluded.state
      OR worker_dock_facts.report_id IS NOT excluded.report_id
      THEN excluded.changed_at ELSE worker_dock_facts.changed_at END,
    model = excluded.model, reason = excluded.reason, report_id = excluded.report_id, result_lost_at = CASE WHEN excluded.report_id IS NOT NULL THEN NULL ELSE worker_dock_facts.result_lost_at END, settlement = CASE WHEN worker_dock_facts.state = excluded.state
      AND worker_dock_facts.report_id IS excluded.report_id THEN worker_dock_facts.settlement ELSE excluded.settlement END
    WHERE worker_dock_facts.source IS NOT excluded.source OR worker_dock_facts.home <> excluded.home
      OR worker_dock_facts.state <> excluded.state OR worker_dock_facts.report_id IS NOT excluded.report_id OR worker_dock_facts.model IS NOT excluded.model OR worker_dock_facts.reason IS NOT excluded.reason;
`

export function installWorkerDockSchema(this: OrchestrationDb): void {
  const installed = this.db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'worker_dock_facts'")
    .get()
  this.db.exec('CREATE TABLE IF NOT EXISTS worker_dock_authority (id TEXT PRIMARY KEY)')
  if (!this.db.prepare('SELECT id FROM worker_dock_authority LIMIT 1').get()) {
    this.db.prepare('INSERT INTO worker_dock_authority(id) VALUES(?)').run(randomUUID())
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS worker_dock_facts (
      dispatch_id TEXT PRIMARY KEY, source TEXT, home TEXT NOT NULL, state TEXT NOT NULL,
      changed_at INTEGER, report_id TEXT, settlement TEXT, result_lost_at INTEGER, model TEXT, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS worker_dock_result_time ON worker_dock_facts(source, changed_at DESC, dispatch_id) WHERE report_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS worker_dock_source_state ON worker_dock_facts(source, state);
    CREATE INDEX IF NOT EXISTS worker_dock_eligible ON worker_dock_facts(source)
      WHERE state <> 'succeeded' OR report_id IS NULL;
    CREATE TABLE IF NOT EXISTS worker_dock_activity (
      dispatch_id TEXT PRIMARY KEY, episode TEXT NOT NULL, state TEXT NOT NULL, changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_dock_acknowledgments (
      source TEXT NOT NULL, dispatch_id TEXT NOT NULL, settlement TEXT NOT NULL,
      PRIMARY KEY(source, dispatch_id, settlement)
    );
    CREATE TABLE IF NOT EXISTS worker_dock_owner_stops (
      request_id TEXT PRIMARY KEY, source TEXT NOT NULL, dispatch_id TEXT NOT NULL,
      receipt TEXT, confirmed INTEGER NOT NULL DEFAULT 0, settlement TEXT
    );
    CREATE INDEX IF NOT EXISTS worker_dock_owner_stop_attempt ON worker_dock_owner_stops(dispatch_id, confirmed);
    CREATE TABLE IF NOT EXISTS worker_dock_failure_results (
      dispatch_id TEXT PRIMARY KEY, source TEXT NOT NULL, id TEXT NOT NULL,
      changed_at INTEGER, settlement TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_dock_failure_result_time ON worker_dock_failure_results(source, changed_at DESC, dispatch_id);
    CREATE TABLE IF NOT EXISTS worker_dock_stop_results (
      dispatch_id TEXT PRIMARY KEY, source TEXT NOT NULL, id TEXT NOT NULL,
      changed_at INTEGER, settlement TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_dock_stop_result_time ON worker_dock_stop_results(source, changed_at DESC, dispatch_id);
    CREATE TABLE IF NOT EXISTS worker_dock_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO worker_dock_revision VALUES(1, 0);
    CREATE TABLE IF NOT EXISTS worker_dock_provider_failures (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, settlement TEXT NOT NULL, changed_at INTEGER NOT NULL,
      entry TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_dock_provider_failure_source ON worker_dock_provider_failures(source);
  `)
  if (!this.hasColumn('worker_dock_facts', 'result_lost_at')) {
    this.db.exec('ALTER TABLE worker_dock_facts ADD COLUMN result_lost_at INTEGER')
  }
  for (const column of ['model', 'reason']) {
    if (!this.hasColumn('worker_dock_facts', column)) {
      this.db.exec(`ALTER TABLE worker_dock_facts ADD COLUMN ${column} TEXT`)
    }
  }
  for (const [table, identity, columns] of [
    ['worker_dispatches', 'NEW.dispatch_id', 'state, start_options, last_error'],
    ['dispatch_contexts', 'NEW.id', 'creator_orca_session_id'],
    ['attempt_observation_facts', 'NEW.dispatch_id', 'payload']
  ]) {
    for (const event of ['INSERT', `UPDATE OF ${columns}`]) {
      this.db
        .exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_${table}_${event.startsWith('UPDATE') ? 'update' : 'insert'}
        AFTER ${event} ON ${table} BEGIN ${projection(identity)} END;`)
    }
  }
  this.db
    .exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_run_source AFTER UPDATE OF coordinator_orca_session_id ON runs BEGIN
    UPDATE worker_dock_facts SET source = NEW.coordinator_orca_session_id
      WHERE dispatch_id IN (SELECT id FROM dispatch_contexts WHERE run_id = NEW.id AND creator_orca_session_id IS NULL AND creator_dispatch_id IS NULL);
  END;
  CREATE TRIGGER IF NOT EXISTS worker_dock_report_deleted AFTER DELETE ON messages BEGIN
    UPDATE worker_dock_facts SET report_id = NULL, result_lost_at = CAST(round(unixepoch('now', 'subsec') * 1000) AS INTEGER), changed_at = CAST(round(unixepoch('now', 'subsec') * 1000) AS INTEGER) WHERE report_id = OLD.id;
  END;`)
  this.db.exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_report_inserted AFTER INSERT ON messages
    WHEN NEW.type = 'worker_done' BEGIN
    ${projection("(SELECT dispatch_id FROM attempt_observation_facts WHERE id = 'worker_report:' || NEW.id)")}
  END;`)
  for (const event of ['INSERT', 'UPDATE']) {
    this.db
      .exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_failure_result_${event} AFTER ${event} ON worker_dock_facts BEGIN
      DELETE FROM worker_dock_failure_results WHERE dispatch_id = NEW.dispatch_id;
      INSERT INTO worker_dock_failure_results(dispatch_id, source, id, changed_at, settlement)
        SELECT NEW.dispatch_id, NEW.source, 'settlement:' || NEW.settlement, NEW.changed_at, NEW.settlement
        WHERE NEW.source IS NOT NULL AND NEW.report_id IS NULL AND NEW.settlement IS NOT NULL
          AND NEW.state IN ('failed', 'stopped', 'abandoned')
          AND NOT EXISTS(SELECT 1 FROM worker_dock_owner_stops s WHERE s.dispatch_id = NEW.dispatch_id AND s.confirmed = 1 AND s.settlement = NEW.settlement);
    END;`)
  }
  this.db
    .exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_confirmed_stop AFTER UPDATE ON worker_dock_owner_stops
    WHEN NEW.confirmed = 1 AND NEW.settlement IS NOT NULL BEGIN
    DELETE FROM worker_dock_failure_results WHERE dispatch_id = NEW.dispatch_id;
    INSERT OR IGNORE INTO worker_dock_stop_results(dispatch_id, source, id, changed_at, settlement)
      SELECT NEW.dispatch_id, NEW.source, 'owner_stop:' || NEW.request_id, changed_at, NEW.settlement
      FROM worker_dock_facts WHERE dispatch_id = NEW.dispatch_id;
  END;`)
  for (const table of [
    'worker_dock_facts',
    'worker_dock_activity',
    'worker_dock_acknowledgments',
    'worker_dock_provider_failures',
    'worker_dock_owner_stops'
  ]) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_revision_${table}_${event}
        AFTER ${event} ON ${table} BEGIN UPDATE worker_dock_revision SET revision = revision + 1 WHERE id = 1; END;`)
    }
  }
  this.db
    .exec(`CREATE TRIGGER IF NOT EXISTS worker_dock_dispatch_delete AFTER DELETE ON dispatch_contexts BEGIN
    DELETE FROM worker_dock_failure_results WHERE dispatch_id = OLD.id;
    DELETE FROM worker_dock_stop_results WHERE dispatch_id = OLD.id;
    DELETE FROM worker_dock_activity WHERE dispatch_id = OLD.id;
    DELETE FROM worker_dock_facts WHERE dispatch_id = OLD.id;
    DELETE FROM worker_dock_acknowledgments WHERE dispatch_id = OLD.id;
    DELETE FROM worker_dock_owner_stops WHERE dispatch_id = OLD.id;
  END;`)
  if (!installed) {
    runLifecycleWriteTransaction(this.db, 'worker_dock_install', () => {
      for (const row of this.db.prepare('SELECT dispatch_id FROM worker_dispatches').all()) {
        this.db.prepare(projection('?')).run(row.dispatch_id)
      }
    })
  }
}
