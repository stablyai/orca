import type Database from '../../../sqlite/sync-database'

const positions = new WeakMap<Database.Database, { coverage: number; locator: number }>()

/** The existing paced sweeper retires disposable access records, one bounded page at a time. */
export function sweepJournalHistoryPage(db: Database.Database): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'journal_history_coverage'").get()) {
    return false
  }
  const position = positions.get(db) ?? { coverage: 0, locator: 0 }
  positions.set(db, position)
  const coverage = db
    .prepare(`SELECT rowid, session_id, epoch, generation
    FROM journal_history_coverage WHERE rowid > ? ORDER BY rowid LIMIT 32`)
    .all(position.coverage)
  const current = db.prepare(`SELECT 1 FROM journal_sessions s
    LEFT JOIN journal_outcome_epochs e ON e.session_id = s.session_id AND e.epoch = s.epoch
    WHERE s.session_id = ? AND s.epoch = ? AND (? = 0 OR e.generation = ?)`)
  for (const row of coverage) {
    position.coverage = Number(row.rowid)
    if (!current.get(row.session_id, row.epoch, row.generation, row.generation)) {
      db.prepare('DELETE FROM journal_history_coverage WHERE rowid = ?').run(row.rowid)
    }
  }
  const locators = db
    .prepare(`SELECT rowid, session_id, epoch, generation, incarnation
    FROM journal_history_locators WHERE rowid > ? ORDER BY rowid LIMIT 32`)
    .all(position.locator)
  const live = db.prepare(`SELECT 1 FROM journal_history_coverage
    WHERE session_id = ? AND epoch = ? AND generation = ? AND incarnation = ?`)
  for (const row of locators) {
    position.locator = Number(row.rowid)
    if (!live.get(row.session_id, row.epoch, row.generation, row.incarnation)) {
      db.prepare('DELETE FROM journal_history_locators WHERE rowid = ?').run(row.rowid)
    }
  }
  if (coverage.length === 32 || locators.length === 32) {
    return true
  }
  positions.delete(db)
  return false
}
