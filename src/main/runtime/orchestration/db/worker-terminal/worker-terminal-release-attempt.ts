import type { OrchestrationDb } from '../orchestration-db'

const RELEASE_ATTEMPTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS worker_terminal_release_attempts (
  resource_id TEXT PRIMARY KEY,
  attempt     INTEGER NOT NULL
)`

const RELEASE_ATTEMPTS_TRIGGER_NAME = 'trg_worker_terminal_release_attempts_delete'

// Stored as written, so a changed body differs from sqlite_master and is reinstalled.
const RELEASE_ATTEMPTS_TRIGGER_SQL = `CREATE TRIGGER ${RELEASE_ATTEMPTS_TRIGGER_NAME}
AFTER DELETE ON worker_terminal_resources
BEGIN
  DELETE FROM worker_terminal_release_attempts WHERE resource_id = OLD.id;
END`

/**
 * Each resource's keep-open revision lives beside it rather than on it, so no reader of the resource
 * row changes shape. The trigger is stored in the file: a delete by any build, older ones included,
 * removes the revision with its resource.
 */
const RELEASE_ATTEMPTS_INSTALL_SQL = `
${RELEASE_ATTEMPTS_TABLE_SQL};
DROP TRIGGER IF EXISTS ${RELEASE_ATTEMPTS_TRIGGER_NAME};
${RELEASE_ATTEMPTS_TRIGGER_SQL};
DELETE FROM worker_terminal_release_attempts
 WHERE resource_id NOT IN (SELECT id FROM worker_terminal_resources);
`

function isReleaseAttemptsCurrent(db: OrchestrationDb['db']): boolean {
  const stored = db
    .prepare(
      `SELECT type, sql FROM sqlite_master
        WHERE (type = 'trigger' AND name = ?) OR (type = 'table' AND name = 'worker_terminal_release_attempts')`
    )
    .all(RELEASE_ATTEMPTS_TRIGGER_NAME)
  return (
    stored.some((row) => row.type === 'table') &&
    stored.some((row) => row.type === 'trigger' && row.sql === RELEASE_ATTEMPTS_TRIGGER_SQL)
  )
}

/** Installs only when the table or trigger is missing or differs; revisions left by a delete without it are swept then. */
export function installWorkerTerminalReleaseAttempts({ db }: Pick<OrchestrationDb, 'db'>): void {
  if (isReleaseAttemptsCurrent(db)) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    // Another process may have installed it while this one waited for the lock.
    if (!isReleaseAttemptsCurrent(db)) {
      db.exec(RELEASE_ATTEMPTS_INSTALL_SQL)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Caller owns the transaction. Every applied keep-open is a new intent, even one that rewrites the same state. */
export function bumpWorkerTerminalReleaseAttempt(
  { db }: Pick<OrchestrationDb, 'db'>,
  resourceId: string
): void {
  db.prepare(
    `INSERT INTO worker_terminal_release_attempts (resource_id, attempt) VALUES (?, 1)
     ON CONFLICT(resource_id) DO UPDATE SET attempt = attempt + 1`
  ).run(resourceId)
}

/** A resource never kept open reads 0. */
export function readWorkerTerminalReleaseAttempt(
  { db }: Pick<OrchestrationDb, 'db'>,
  resourceId: string
): number {
  const row = db
    .prepare('SELECT attempt FROM worker_terminal_release_attempts WHERE resource_id = ?')
    .get(resourceId)
  return Number(row?.attempt ?? 0)
}
