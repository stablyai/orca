import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { JOURNAL_DOMAIN_SCHEMA_001 } from './journal-domain-schema-001'

export const JOURNAL_DOMAIN_MIGRATIONS: readonly {
  version: number
  migrate: (db: Database.Database) => void
}[] = [
  { version: 1, migrate: (db) => db.exec(JOURNAL_DOMAIN_SCHEMA_001) },
  {
    version: 2,
    migrate: (db) =>
      db.exec(`
      ALTER TABLE agent_session_operations ADD COLUMN operation_id TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(row_json) THEN json_extract(row_json, '$.operationId') END
      ) VIRTUAL;
      CREATE INDEX agent_session_operations_identity ON agent_session_operations(operation_id);
    `)
  }
]

export const JOURNAL_DOMAIN_SCHEMA_VERSION = JOURNAL_DOMAIN_MIGRATIONS.at(-1)!.version

/** Each completed step and its version commit together; reopen resumes the next step. */
export function migrateJournalDomainSchema(db: Database.Database): void {
  const stored = Number(db.pragma('user_version', { simple: true }))
  if (stored > JOURNAL_DOMAIN_SCHEMA_VERSION) {
    throw new Error('journal domain schema is newer than this writer')
  }
  for (const migration of JOURNAL_DOMAIN_MIGRATIONS) {
    if (migration.version > stored) {
      runJournalTransaction(db, () => {
        migration.migrate(db)
        db.pragma(`user_version = ${migration.version}`)
      })
    }
  }
}
