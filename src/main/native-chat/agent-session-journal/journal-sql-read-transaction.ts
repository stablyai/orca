import type Database from '../../sqlite/sync-database'
import { currentJournalSqlEpoch, JournalProjectionStaleError } from './journal-sql-meta'
import { JournalSqlScope } from './journal-sql-scope'

/** Readiness and every value used for the answer belong to the same WAL snapshot. */
export function readJournalSqlProjection<T>(
  db: Database.Database,
  sessionId: string,
  read: (scope: JournalSqlScope) => T
): T {
  db.exec('BEGIN')
  try {
    const epoch = currentJournalSqlEpoch(db, sessionId)
    if (epoch === null) {
      throw new JournalProjectionStaleError('chat needs conversion before reading')
    }
    const result = read(new JournalSqlScope(db, sessionId, epoch))
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
