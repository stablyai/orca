import type { OrchestrationDb } from '../orchestration-db'

const priorOwnerIdsSql = (row: 'NEW' | 'r') =>
  `json_each(CASE WHEN json_valid(${row}.prior_owner_dispatch_ids)
     THEN ${row}.prior_owner_dispatch_ids ELSE '[]' END) AS prior`

const INSERT_PRIOR_OWNERS_SQL = `INSERT OR IGNORE INTO worker_terminal_resource_prior_owners (dispatch_id, resource_id)
    SELECT prior.value, NEW.id FROM ${priorOwnerIdsSql('NEW')} WHERE prior.type = 'text';`

// Compare the full prefix without rebuilding or enumerating its JSON values.
const OWNER_APPEND_SQL = `OLD.id IS NEW.id AND OLD.owner_dispatch_id IS NOT NEW.owner_dispatch_id
  AND NEW.prior_owner_dispatch_ids IS CASE
    WHEN OLD.prior_owner_dispatch_ids = '[]' THEN json_array(OLD.owner_dispatch_id)
    WHEN substr(OLD.prior_owner_dispatch_ids, 1, 1) = '['
      AND substr(OLD.prior_owner_dispatch_ids, -2) = '"]'
    THEN substr(OLD.prior_owner_dispatch_ids, 1, length(OLD.prior_owner_dispatch_ids) - 1)
      || ',' || substr(json_array(OLD.owner_dispatch_id), 2)
  END AND json_valid(OLD.prior_owner_dispatch_ids)`

// Stored as written, so a changed body differs from sqlite_master and is reinstalled.
const PRIOR_OWNER_TRIGGERS: Record<string, string> = {
  trg_worker_terminal_prior_owners_insert: `CREATE TRIGGER trg_worker_terminal_prior_owners_insert
AFTER INSERT ON worker_terminal_resources
BEGIN
  ${INSERT_PRIOR_OWNERS_SQL}
END`,
  trg_worker_terminal_prior_owners_update: `CREATE TRIGGER trg_worker_terminal_prior_owners_update
AFTER UPDATE OF id, prior_owner_dispatch_ids ON worker_terminal_resources
WHEN OLD.id IS NOT NEW.id OR OLD.prior_owner_dispatch_ids IS NOT NEW.prior_owner_dispatch_ids
BEGIN
  DELETE FROM worker_terminal_resource_prior_owners
    WHERE resource_id = CASE WHEN ${OWNER_APPEND_SQL} THEN NULL ELSE OLD.id END
    AND (OLD.id IS NOT NEW.id OR dispatch_id NOT IN (
      SELECT prior.value FROM ${priorOwnerIdsSql('NEW')} WHERE prior.type = 'text'));
  INSERT OR IGNORE INTO worker_terminal_resource_prior_owners (dispatch_id, resource_id)
    SELECT prior.value, NEW.id FROM json_each(CASE
      WHEN ${OWNER_APPEND_SQL} THEN json_array(OLD.owner_dispatch_id)
      WHEN json_valid(NEW.prior_owner_dispatch_ids) THEN NEW.prior_owner_dispatch_ids
      ELSE '[]' END) AS prior WHERE prior.type = 'text';
END`,
  trg_worker_terminal_prior_owners_delete: `CREATE TRIGGER trg_worker_terminal_prior_owners_delete
AFTER DELETE ON worker_terminal_resources
BEGIN
  DELETE FROM worker_terminal_resource_prior_owners WHERE resource_id = OLD.id;
END`
}

/**
 * Indexed lookup of `prior_owner_dispatch_ids`, which a leading-wildcard LIKE can only scan.
 * The JSON column stays the ordered source of truth; triggers stored in the file keep this
 * table current under older builds too, so it needs no user_version change.
 */
const PRIOR_OWNER_INDEX_SQL = `
CREATE TABLE IF NOT EXISTS worker_terminal_resource_prior_owners (
  dispatch_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, resource_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resource_prior_owners_resource
  ON worker_terminal_resource_prior_owners(resource_id);
${Object.entries(PRIOR_OWNER_TRIGGERS)
  .map(([name, sql]) => `DROP TRIGGER IF EXISTS ${name};\n${sql};`)
  .join('\n')}
DELETE FROM worker_terminal_resource_prior_owners;
INSERT OR IGNORE INTO worker_terminal_resource_prior_owners (dispatch_id, resource_id)
  SELECT prior.value, r.id FROM worker_terminal_resources r, ${priorOwnerIdsSql('r')}
   WHERE prior.type = 'text';
`

function isPriorOwnerIndexCurrent(db: OrchestrationDb['db']): boolean {
  const names = Object.keys(PRIOR_OWNER_TRIGGERS)
  const stored = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
        AND name IN (${names.map(() => '?').join(', ')})`
    )
    .all(...names)
  return (
    stored.length === names.length &&
    stored.every((row) => PRIOR_OWNER_TRIGGERS[String(row.name)] === row.sql)
  )
}

/** Rebuilds only when a trigger is missing or differs, since rows written without it may be stale. */
export function installWorkerTerminalPriorOwnerIndex({ db }: Pick<OrchestrationDb, 'db'>): void {
  if (isPriorOwnerIndexCurrent(db)) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    // Another process may have installed it while this one waited for the lock.
    if (!isPriorOwnerIndexCurrent(db)) {
      db.exec(PRIOR_OWNER_INDEX_SQL)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** The resource a Dispatch most recently handed on; history only names it, it never grants release. */
export function formerlyOwnedResourceIdSql(dispatchIdSql: string): string {
  return `(SELECT r.id FROM worker_terminal_resource_prior_owners p
     JOIN worker_terminal_resources r ON r.id = p.resource_id
    WHERE p.dispatch_id = ${dispatchIdSql} ORDER BY r.updated_at DESC LIMIT 1)`
}
