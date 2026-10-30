import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import { activeJournalGenerations, ownJournalMaintenance } from './journal-maintenance'

const sweepPositions = new WeakMap<Database.Database, number>()

/** Descriptors drive cleanup, including interrupted attempts for still-current epochs. */
export function sweepJournalOutcomePage(database: JournalHostDatabase): boolean {
  return database.transaction((db) => {
    const after = sweepPositions.get(db) ?? 0
    const candidates = db
      .prepare(`SELECT a.rowid AS position, a.session_id, a.epoch, a.generation
      FROM journal_outcome_attempts a LEFT JOIN journal_outcome_epochs e
      ON e.session_id = a.session_id AND e.epoch = a.epoch AND e.generation = a.generation
      WHERE e.session_id IS NULL AND a.rowid > ? ORDER BY a.rowid LIMIT 32`)
      .all(after)
    let more = false
    for (const row of candidates) {
      if (typeof row.position === 'number') {
        sweepPositions.set(db, row.position)
      }
      if (
        typeof row.session_id !== 'string' ||
        typeof row.epoch !== 'string' ||
        typeof row.generation !== 'string' ||
        activeJournalGenerations.has(row.generation)
      ) {
        continue
      }
      const owner = ownJournalMaintenance(db, row.session_id, row.epoch, 0)
      if (!owner) {
        continue
      }
      try {
        const removed = db
          .prepare(`DELETE FROM journal_outcomes WHERE rowid IN (
          SELECT rowid FROM journal_outcomes WHERE session_id = ? AND epoch = ?
          AND generation = ? LIMIT 32)`)
          .run(row.session_id, row.epoch, row.generation)
        if (removed.changes > 0) {
          more = true
        } else {
          db.prepare(`DELETE FROM journal_outcome_attempts
            WHERE session_id = ? AND epoch = ? AND generation = ?`).run(
            row.session_id,
            row.epoch,
            row.generation
          )
        }
        // One bounded data page per transaction, even with many retired generations.
        if (more) {
          sweepPositions.set(db, after)
          return true
        }
      } finally {
        owner.release()
      }
    }
    if (candidates.length === 32) {
      return true
    }
    sweepPositions.delete(db)
    return false
  })
}
