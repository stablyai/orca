import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { JOURNAL_DOMAIN_MIGRATIONS } from './journal-domain-migrations'

/** Seed a real predecessor using the same numbered list, without reverse-engineering current DDL. */
export function migrateJournalDomainPredecessor(db: Database.Database, through: number): void {
  for (const migration of JOURNAL_DOMAIN_MIGRATIONS) {
    if (migration.version <= through) {
      runJournalTransaction(db, () => {
        migration.migrate(db)
        db.pragma(`user_version=${migration.version}`)
      })
    }
  }
}
