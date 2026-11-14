import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { JOURNAL_DOMAIN_SCHEMA_001 } from './journal-domain-schema-001'

export const JOURNAL_DOMAIN_SCHEMA_VERSION = 2

/** The domain database starts at one frozen schema; shipped source formats import separately. */
export function migrateJournalDomainSchema(db: Database.Database): void {
  const stored = Number(db.pragma('user_version', { simple: true }))
  if (stored > JOURNAL_DOMAIN_SCHEMA_VERSION) {
    throw new Error('journal domain schema is newer than this writer')
  }
  if (stored < JOURNAL_DOMAIN_SCHEMA_VERSION) {
    runJournalTransaction(db, () => {
      if (stored < 1) {
        db.exec(JOURNAL_DOMAIN_SCHEMA_001)
      } else if (stored === 1) {
        db.exec('ALTER TABLE journal_items ADD COLUMN wire_version INTEGER')
      }
      db.pragma(`user_version = ${JOURNAL_DOMAIN_SCHEMA_VERSION}`)
    })
  }
}
