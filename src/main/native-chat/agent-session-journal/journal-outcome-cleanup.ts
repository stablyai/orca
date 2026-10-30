import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import { activeJournalGenerations, ownJournalMaintenance } from './journal-maintenance'

const sweepPositions = new WeakMap<Database.Database, number>()

/** Descriptors drive cleanup, including interrupted attempts for still-current epochs. */
export function sweepJournalOutcomePage(database: JournalHostDatabase): boolean {
  return database.transaction((db) => {
    const after = sweepPositions.get(db) ?? 0
    const candidates = db
      .prepare(`SELECT a.generation, a.session_id, a.epoch
      FROM journal_outcome_attempts a LEFT JOIN journal_outcome_epochs e
      ON e.session_id = a.session_id AND e.epoch = a.epoch AND e.generation = a.generation
      WHERE e.session_id IS NULL AND a.generation > ? ORDER BY a.generation LIMIT 32`)
      .all(after)
    for (const row of candidates) {
      const { generation, session_id: sessionId, epoch } = row
      if (typeof generation !== 'number') {
        continue
      }
      sweepPositions.set(db, generation)
      if (
        typeof sessionId !== 'string' ||
        typeof epoch !== 'string' ||
        activeJournalGenerations.has(generation)
      ) {
        continue
      }
      const owner = ownJournalMaintenance(db, sessionId, epoch)
      if (!owner) {
        continue
      }
      try {
        const removed = db
          .prepare(`DELETE FROM journal_outcomes WHERE rowid IN (
          SELECT rowid FROM journal_outcomes WHERE generation = ? LIMIT 32)`)
          .run(generation)
        if (removed.changes === 0) {
          db.prepare('DELETE FROM journal_outcome_attempts WHERE generation = ?').run(generation)
          continue
        }
        // One bounded data page per transaction, even with many retired generations.
        sweepPositions.set(db, after)
        return true
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
