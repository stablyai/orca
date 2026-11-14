import type Database from '../../sqlite/sync-database'
import { JournalSqlScope } from './journal-sql-scope'

/** Readiness and every value used for the answer belong to the same WAL snapshot. */
export function readJournalSqlProjection<T>(
  db: Database.Database,
  sessionId: string,
  read: (scope: JournalSqlScope) => T
): T {
  db.exec('BEGIN')
  try {
    const epoch =
      db
        .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL')
        .get(sessionId)
        ?.epoch?.toString() ?? null
    if (epoch === null) {
      throw new Error('chat needs conversion before reading')
    }
    const result = read(new JournalSqlScope(db, sessionId, epoch))
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
