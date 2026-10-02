// Per-chat journal files as an earlier build left them, staged for tests of their copy into the
// host's one database.

import { mkdirSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import { legacyJournalDatabaseFile } from './journal-paths'
import { iterateJournalEpochRows, readJournalSessionEpoch } from './journal-row-table'
import type { JournalStoredRow } from './journal-row-table'

export type PerChatJournalRepair = { epoch: string; contentFrom: number; repairedAt: number }

/** Writes `<directory>/journal.db` in the per-chat schema (version 2), with the chat's rows, its
 *  epoch and, when given, its repair marker. Returns the file's path. */
export function writePerChatJournalFile(
  directory: string,
  sessionId: string,
  input: { epoch: string; rows: readonly JournalStoredRow[]; repair?: PerChatJournalRepair | null }
): string {
  mkdirSync(directory, { recursive: true })
  const path = legacyJournalDatabaseFile(directory)
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
CREATE TABLE journal_rows (session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (session_id, epoch, seq));
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);`)
    db.pragma('user_version = 2')
    const insert = db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of input.rows) {
      insert.run(sessionId, input.epoch, row.seq, row.ts, row.rowJson)
    }
    db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(sessionId, input.epoch, 1)
    if (input.repair) {
      db.prepare('INSERT INTO journal_repairs VALUES (?, ?, ?, ?)').run(
        sessionId,
        input.repair.epoch,
        input.repair.contentFrom,
        input.repair.repairedAt
      )
    }
  } finally {
    db.close()
  }
  return path
}

const CHAT_TABLES = [
  'journal_rows',
  'journal_sessions',
  'journal_session_state',
  'journal_imports',
  'journal_repairs'
] as const

/**
 * Moves a chat out of the host's database into the per-chat file an earlier build would have left
 * for it, so the database holds nothing of it. For a chat no journal handle has open.
 */
export function moveChatToPerChatFile(
  database: JournalHostDatabase,
  identity: { sessionId: string; workspaceId: string }
): string {
  const { db } = database
  const { sessionId } = identity
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    throw new Error(`no journal for ${sessionId}`)
  }
  const repair = db
    .prepare('SELECT epoch, content_from, repaired_at FROM journal_repairs WHERE session_id = ?')
    .get(sessionId)
  const directory = database.legacyDirectoryFor(identity)
  writePerChatJournalFile(directory, sessionId, {
    epoch,
    rows: [...iterateJournalEpochRows(db, sessionId, epoch)],
    repair: repair
      ? {
          epoch: String(repair.epoch),
          contentFrom: Number(repair.content_from),
          repairedAt: Number(repair.repaired_at)
        }
      : null
  })
  database.transaction((tx) => {
    for (const table of CHAT_TABLES) {
      tx.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
    }
  })
  return directory
}
