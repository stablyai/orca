import type Database from '../../../../sqlite/sync-database'
import { currentRunCoordinatorSessionAddressSql } from './run-coordinator-orca-session'
import { orcaSessionAddressSql } from '../orca-session-address-sql'

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const RUN_EVENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orchestration_run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT,
  dispatch_id TEXT,
  recorded_at TEXT NOT NULL DEFAULT (${NOW}),
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestration_run_events_run
  ON orchestration_run_events(run_id, sequence);
CREATE TABLE IF NOT EXISTS orchestration_run_event_coverage (
  run_id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL DEFAULT (hex(randomblob(16))),
  recorded_since TEXT NOT NULL DEFAULT (${NOW}),
  complete_from_creation INTEGER NOT NULL
);
`

function captureEntity(
  table: string,
  entity: 'task' | 'dispatch' | 'gate'
): Record<string, string> {
  const taskId = entity === 'task' ? 'NEW.id' : 'NEW.task_id'
  const dispatchId = entity === 'dispatch' ? 'NEW.id' : 'NULL'
  const details =
    entity === 'task'
      ? "'title', CAST(COALESCE(NEW.task_title, NEW.display_name) AS TEXT),"
      : entity === 'dispatch'
        ? "'retryOfDispatchId', CAST(NEW.retry_of_dispatch_id AS TEXT),"
        : ''
  const insert = (kind: string, fields: string, row = 'NEW'): string =>
    `INSERT INTO orchestration_run_events (run_id, kind, entity_id, task_id, dispatch_id, data)
     VALUES (${row}.run_id, '${entity}.${kind}', ${row}.id,
       ${taskId.replaceAll('NEW.', `${row}.`)}, ${dispatchId.replaceAll('NEW.', `${row}.`)},
       json_object(${fields}${
         entity === 'dispatch'
           ? `, 'assignee', COALESCE(${orcaSessionAddressSql(`${row}.assignee_orca_session_id`)}, ${row}.assignee_handle)`
           : ''
       }));`

  return {
    [`trg_run_events_${entity}_created`]: `AFTER INSERT ON ${table} BEGIN
      ${insert('created', `${details} 'status', NEW.status`)} END`,
    [`trg_run_events_${entity}_status`]: `AFTER UPDATE OF status ON ${table}
      WHEN OLD.status IS NOT NEW.status BEGIN
      ${insert('status_changed', "'previousStatus', OLD.status, 'status', NEW.status")} END`,
    [`trg_run_events_${entity}_removed`]: `AFTER DELETE ON ${table} BEGIN
      ${insert('removed', "'status', OLD.status", 'OLD')} END`
  }
}

const coordinator = (row: string): string =>
  `COALESCE(${currentRunCoordinatorSessionAddressSql(row)}, ${row}.coordinator_handle)`

const CAPTURE_TRIGGERS: Record<string, string> = {
  trg_run_events_created: `AFTER INSERT ON runs BEGIN
    INSERT INTO orchestration_run_event_coverage (run_id, complete_from_creation)
      VALUES (NEW.id, 1);
    INSERT INTO orchestration_run_events (run_id, kind, entity_id, data)
      VALUES (NEW.id, 'run.created', NEW.id,
        json_object('coordinator', ${coordinator('NEW')}, 'generation', NEW.consumer_generation));
    END`,
  trg_run_events_coordinator: `AFTER UPDATE OF consumer_generation ON runs
    WHEN OLD.consumer_generation IS NOT NEW.consumer_generation BEGIN
    INSERT INTO orchestration_run_events (run_id, kind, entity_id, data)
      VALUES (NEW.id, 'run.coordinator_changed', NEW.id,
        json_object('previousCoordinator', ${coordinator('OLD')},
          'coordinator', ${coordinator('NEW')}, 'generation', NEW.consumer_generation));
    END`,
  trg_run_events_forget: `AFTER DELETE ON runs BEGIN
    DELETE FROM orchestration_run_events WHERE run_id = OLD.id;
    DELETE FROM orchestration_run_event_coverage WHERE run_id = OLD.id;
    END`,
  ...captureEntity('tasks', 'task'),
  ...captureEntity('dispatch_contexts', 'dispatch'),
  ...captureEntity('decision_gates', 'gate')
}

export const DROP_RUN_EVENT_TRIGGERS_SQL = Object.keys(CAPTURE_TRIGGERS)
  .map((name) => `DROP TRIGGER IF EXISTS ${name};`)
  .join('\n')

export function isRunEventCaptureIntact(db: Database.Database): boolean {
  return Object.entries(CAPTURE_TRIGGERS).every(([name, body]) => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name)
    return row?.sql === `CREATE TRIGGER ${name} ${body}`
  })
}

// Install after migrations: legacy table rebuilds must not produce events or retain stale triggers.
export function installRunEventCapture(db: Database.Database, captureWasIntact: boolean): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(RUN_EVENT_SCHEMA_SQL)
    if (!captureWasIntact) {
      db.exec(`UPDATE orchestration_run_event_coverage
        SET complete_from_creation = 0, recorded_since = ${NOW}, recording_id = hex(randomblob(16));`)
    }
    db.exec(`INSERT OR IGNORE INTO orchestration_run_event_coverage (run_id, complete_from_creation)
      SELECT id, 0 FROM runs;`)
    db.exec(DROP_RUN_EVENT_TRIGGERS_SQL)
    for (const [name, body] of Object.entries(CAPTURE_TRIGGERS)) {
      db.exec(`CREATE TRIGGER ${name} ${body}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
