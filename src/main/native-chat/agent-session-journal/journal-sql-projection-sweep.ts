import type Database from '../../sqlite/sync-database'

type ProjectionTable = { name: string; key: string }

/** Each epoch's registry rows go last, so a scope stays findable until its other rows are gone. */
const REGISTRIES = ['journal_proj_domain_counters', 'journal_proj_sessions']

const tables = new WeakMap<Database.Database, ProjectionTable[]>()

/** Every derived table, each keyed by (session_id, epoch, ...); the meta row is never swept. */
function projectionTables(db: Database.Database): ProjectionTable[] {
  let found = tables.get(db)
  if (!found) {
    found = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name LIKE 'journal_proj_%' AND name <> 'journal_proj_meta' ORDER BY name`)
      .all()
      .map(({ name }) => String(name))
      .sort((a, b) => Number(REGISTRIES.includes(a)) - Number(REGISTRIES.includes(b)))
      .map((name) => ({
        name,
        key: db
          .prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`)
          .all(name)
          .map((column) => String(column.name))
          .join(', ')
      }))
    tables.set(db, found)
  }
  return found
}

/**
 * Deletes at most `limit` derived rows of one chat, from one epoch or all of them; true while
 * rows remain. The saved log is never touched.
 */
export function deleteJournalSqlProjectionPage(
  db: Database.Database,
  sessionId: string,
  epoch: string | null,
  limit: number
): boolean {
  let budget = limit
  const scope = epoch === null ? 'session_id=?' : 'session_id=? AND epoch=?'
  const values = epoch === null ? [sessionId] : [sessionId, epoch]
  for (const { name, key } of projectionTables(db)) {
    const removed = db
      .prepare(`DELETE FROM "${name}" WHERE (${key}) IN (
        SELECT ${key} FROM "${name}" WHERE ${scope} LIMIT ?)`)
      .run(...values, budget).changes
    budget -= Number(removed)
    if (budget === 0) {
      return true
    }
  }
  return false
}

/**
 * One bounded page of a retired epoch's derived rows, as retired outcome generations are swept:
 * an epoch is retired once its chat's ready projection names another one or the chat is gone.
 * A converting chat is left to its conversion, which clears every epoch of it.
 */
export function sweepJournalSqlProjectionPage(db: Database.Database, limit = 256): boolean {
  const retired = db
    .prepare(`SELECT r.session_id, r.epoch FROM (
        SELECT session_id, epoch FROM journal_proj_domain_counters
        UNION SELECT session_id, epoch FROM journal_proj_sessions) r
      LEFT JOIN journal_proj_meta m ON m.session_id=r.session_id
      WHERE m.session_id IS NULL OR (m.state='ready' AND m.epoch<>r.epoch) LIMIT 1`)
    .get()
  if (!retired) {
    return false
  }
  deleteJournalSqlProjectionPage(db, String(retired.session_id), String(retired.epoch), limit)
  return true
}
