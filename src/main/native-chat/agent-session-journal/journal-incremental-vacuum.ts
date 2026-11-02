import type { JournalHostDatabase } from './journal-host-database'
import { journalPragmaNumber } from './journal-database'

/** Older non-incremental files reuse freed pages; converting them would require a full rewrite. */
export function vacuumJournalPage(database: Pick<JournalHostDatabase, 'writeAutocommit'>): boolean {
  return database.writeAutocommit((db) => {
    if (
      journalPragmaNumber(db, 'auto_vacuum') !== 2 ||
      journalPragmaNumber(db, 'freelist_count') === 0
    ) {
      return false
    }
    db.pragma('incremental_vacuum(32)')
    return true
  })
}
