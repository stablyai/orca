import { copyFile } from 'node:fs/promises'
import { openJournalDatabase } from './journal-database'
import type { JournalHostDatabase } from './journal-host-database'
import type Database from '../../sqlite/sync-database'

export async function mutateTestJournalFixture<T>(
  database: JournalHostDatabase,
  mutate: (db: Database.Database) => T
): Promise<T> {
  return database.joint(
    async (filename) => {
      const fixture = openJournalDatabase(filename)
      try {
        return mutate(fixture.db)
      } finally {
        fixture.db.close()
      }
    },
    () => {}
  )
}

export async function snapshotTestJournal(
  database: JournalHostDatabase,
  destination: string
): Promise<void> {
  await database.joint(
    (filename) => copyFile(filename, destination),
    () => {}
  )
}
