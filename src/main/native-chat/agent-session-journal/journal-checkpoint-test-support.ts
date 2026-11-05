import { mkdirSync } from 'node:fs'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import type Database from '../../sqlite/sync-database'

/** Exercise the unchanged native checkpoint owner directly; host transport has separate contracts. */
export function openNativeCheckpointFixture(stateDirectory: string) {
  mkdirSync(stateDirectory, { recursive: true })
  const filename = journalDatabasePath(stateDirectory)
  const { db, readOnly } = openJournalDatabase(filename)
  const checkpoint = readOnly ? undefined : new JournalCheckpointOwner(db, filename)
  let closed = false
  return {
    db,
    readOnly,
    transaction<T>(run: (db: Database.Database) => T, streamed = false): T {
      if (streamed) {
        db.pragma('synchronous = NORMAL')
      }
      let result: T
      try {
        result = runJournalTransaction(db, run)
      } finally {
        if (streamed && !db.isTransaction) {
          db.pragma('synchronous = FULL')
        }
      }
      checkpoint?.afterCommit()
      return result
    },
    writeAutocommit<T>(run: (db: Database.Database) => T): T {
      try {
        return run(db)
      } finally {
        checkpoint?.afterCommit()
      }
    },
    async close(): Promise<void> {
      if (closed) {
        return
      }
      await checkpoint?.close()
      db.close()
      closed = true
    }
  }
}
export type NativeCheckpointFixture = ReturnType<typeof openNativeCheckpointFixture>
