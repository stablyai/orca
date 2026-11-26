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
    const result = read(openScope(db, sessionId))
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** The reader processes one request at a time, including while the export yields for cancellation. */
export async function readJournalSqlExport<T>(
  db: Database.Database,
  sessionId: string,
  read: (scope: JournalSqlScope) => Promise<T>
): Promise<T> {
  db.exec('BEGIN')
  try {
    const result = await read(openScope(db, sessionId))
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function openScope(db: Database.Database, sessionId: string): JournalSqlScope {
  const epoch = db
    .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL')
    .get(sessionId)
    ?.epoch?.toString()
  if (epoch === undefined) {
    throw new Error('chat needs conversion before reading')
  }
  return new JournalSqlScope(db, sessionId, epoch)
}
