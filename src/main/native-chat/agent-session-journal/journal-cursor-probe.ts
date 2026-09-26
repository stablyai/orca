// Where a journal stands, read without opening it for use.
//
// A restarted host lists a chat from its saved status only while the journal is still exactly where
// that status was computed. This reads the position the open would compute — the live epoch and its
// newest row — on a read-only connection that sets no pragma and runs no DDL, so the file is left
// byte-identical. Any doubt is a miss (null): the caller then opens the journal properly.
//
// Never `immutable` or `nolock`: those skip the `-wal`, and a turn a crash left only in the WAL
// would read as the old position and bring back a stale "done".

import { existsSync } from 'node:fs'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import Database from '../../sqlite/sync-database'
import { journalPragmaNumber } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabaseFile } from './journal-paths'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { readJournalSessionEpoch } from './journal-row-table'

const SELECT_NEWEST_SEQUENCE =
  'SELECT seq FROM journal_rows WHERE session_id = ? AND epoch = ? ORDER BY seq DESC LIMIT 1'

export function probeJournalCursor(
  journalDir: string,
  sessionId: string
): AgentJournalCursor | null {
  const dbPath = journalDatabaseFile(journalDir)
  if (!existsSync(dbPath)) {
    return null
  }
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    if (journalPragmaNumber(db, 'user_version') !== JOURNAL_DB_SCHEMA_VERSION) {
      return null
    }
    const epoch = readJournalSessionEpoch(db, sessionId)
    if (!epoch || pendingJournalRepairSequence(db, sessionId, epoch) !== null) {
      return null
    }
    const newest = db.prepare(SELECT_NEWEST_SEQUENCE).get(sessionId, epoch)
    const sequence: unknown = newest?.seq
    return typeof sequence === 'number' ? { epoch, sequence } : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // A close that fails leaves nothing this probe can use; the answer stands.
    }
    // A read-only open of a WAL file leaves `-wal`/`-shm` behind at umask permissions.
    hardenSqliteDatabaseFiles(dbPath)
  }
}
