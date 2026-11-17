import type { OrchestrationDb } from '../orchestration-db'

const PRIOR_OWNER_TRIGGERS = [
  'trg_worker_terminal_prior_owners_insert',
  'trg_worker_terminal_prior_owners_update',
  'trg_worker_terminal_prior_owners_delete'
] as const

const priorOwnerIdsSql = (row: 'NEW' | 'r') =>
  `json_each(CASE WHEN json_valid(${row}.prior_owner_dispatch_ids)
     THEN ${row}.prior_owner_dispatch_ids ELSE '[]' END) AS prior`

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
${PRIOR_OWNER_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n')}
CREATE TRIGGER trg_worker_terminal_prior_owners_insert
AFTER INSERT ON worker_terminal_resources
BEGIN
  INSERT OR IGNORE INTO worker_terminal_resource_prior_owners (dispatch_id, resource_id)
    SELECT prior.value, NEW.id FROM ${priorOwnerIdsSql('NEW')} WHERE prior.type = 'text';
END;
CREATE TRIGGER trg_worker_terminal_prior_owners_update
AFTER UPDATE OF id, prior_owner_dispatch_ids ON worker_terminal_resources
WHEN OLD.id IS NOT NEW.id OR OLD.prior_owner_dispatch_ids IS NOT NEW.prior_owner_dispatch_ids
BEGIN
  DELETE FROM worker_terminal_resource_prior_owners WHERE resource_id = OLD.id;
  INSERT OR IGNORE INTO worker_terminal_resource_prior_owners (dispatch_id, resource_id)
    SELECT prior.value, NEW.id FROM ${priorOwnerIdsSql('NEW')} WHERE prior.type = 'text';
END;
CREATE TRIGGER trg_worker_terminal_prior_owners_delete
AFTER DELETE ON worker_terminal_resources
BEGIN
  DELETE FROM worker_terminal_resource_prior_owners WHERE resource_id = OLD.id;
END;
DELETE FROM worker_terminal_resource_prior_owners;
INSERT OR IGNORE INTO worker_terminal_resource_prior_owners (dispatch_id, resource_id)
  SELECT prior.value, r.id FROM worker_terminal_resources r, ${priorOwnerIdsSql('r')}
   WHERE prior.type = 'text';
`

/** Builds the index once; reruns only if a table rebuild dropped its triggers, since rows may then be stale. */
export function installWorkerTerminalPriorOwnerIndex({ db }: Pick<OrchestrationDb, 'db'>): void {
  const installed = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'
        AND name IN (${PRIOR_OWNER_TRIGGERS.map(() => '?').join(', ')})`
    )
    .get(...PRIOR_OWNER_TRIGGERS)
  if (Number(installed?.count) === PRIOR_OWNER_TRIGGERS.length) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(PRIOR_OWNER_INDEX_SQL)
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
