// The host journal database for a test's state directory. One per directory per test process, as
// one per state directory per host process in production, so a test that "restarts" a host on the
// same directory reads the same database the way a restarted host would.

import { resolve } from 'node:path'
import { NO_LEGACY_JOURNAL_RECORDS } from './journal-database'
import { JournalHostDatabase } from './journal-host-database'
import { replayJournal, type JournalLoad } from './journal-open'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'
import {
  iterateJournalEpochRows,
  publishJournalSessionEpoch,
  readJournalSessionEpoch,
  type JournalStoredRow
} from './journal-row-table'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { openAgentSessionJournal } from './journal-store-factory'

const opened = new Map<string, JournalHostDatabase>()

export function openTestJournalHostDatabase(stateDirectory: string): JournalHostDatabase {
  const directory = resolve(stateDirectory)
  const existing = opened.get(directory)
  if (existing && !existing.isClosed) {
    return existing
  }
  const database = JournalHostDatabase.openWith(directory, NO_LEGACY_JOURNAL_RECORDS)
  opened.set(directory, database)
  return database
}

/** Closes this directory's database, so the next open reads the file as a fresh process would. */
export function closeTestJournalHostDatabase(stateDirectory: string): void {
  const directory = resolve(stateDirectory)
  opened.get(directory)?.close()
  opened.delete(directory)
}

/** Closes every database this process opened for tests. */
export function closeTestJournalHostDatabases(): void {
  for (const database of opened.values()) {
    database.close()
  }
  opened.clear()
}

export type TestJournalOptions = Omit<AgentSessionJournalOptions, 'database'> & {
  /** The state directory whose one journal database holds this chat. */
  stateDirectory: string
}

export type TrackedJournalOpener = {
  open: (options: TestJournalOptions) => Promise<AgentSessionJournal>
  track: <T extends AgentSessionJournal>(journal: T) => T
  /** Drains every tracked journal, then closes the databases. */
  closeAll: () => Promise<void>
}

export function createTrackedJournalOpener(): TrackedJournalOpener {
  const journals: AgentSessionJournal[] = []
  return {
    open: async ({ stateDirectory, ...options }) => {
      const journal = await openAgentSessionJournal({
        ...options,
        database: openTestJournalHostDatabase(stateDirectory)
      })
      journals.push(journal)
      return journal
    },
    track: (journal) => {
      journals.push(journal)
      return journal
    },
    closeAll: async () => {
      await Promise.allSettled(journals.splice(0).map((journal) => journal.close()))
      closeTestJournalHostDatabases()
    }
  }
}

/** What a fresh open of the chat would replay, read from the test state directory's database. */
/** What an open of a chat a newer Orca saved is refused with. */
export const SAVED_BY_NEWER_ORCA = {
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' }
  }
}

export function loadTestJournal(stateDirectory: string, sessionId: string): JournalLoad | null {
  return replayJournal(openTestJournalHostDatabase(stateDirectory).db, sessionId)
}

// Staging on-disk states for a case, addressed the way the case thinks of them: by chat and sequence.

function liveEpoch(db: Database.Database, sessionId: string): string {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return epoch
}

/** Points the chat at a new epoch, as a publish would. */
export function publishTestJournalEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string
): void {
  publishJournalSessionEpoch(db, { sessionId, workspaceId: 'ws-1' }, epoch)
}

/** The chat's rows of `epoch` — none once that epoch is no longer the live one. */
export function readTestJournalRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalStoredRow[] {
  return readJournalSessionEpoch(db, sessionId) === epoch
    ? [...iterateJournalEpochRows(db, sessionId, epoch)]
    : []
}

/** The chat's rows of whichever epoch is live now. */
export function liveTestJournalRows(db: Database.Database, sessionId: string): JournalStoredRow[] {
  const epoch = readJournalSessionEpoch(db, sessionId)
  return epoch === null ? [] : [...iterateJournalEpochRows(db, sessionId, epoch)]
}

/** The row under the chat's live epoch, whatever epoch its body names. */
export function insertTestJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): void {
  insertTestJournalRowJson(db, sessionId, row.seq, serializeJournalRow(row), row.ts)
}

/** A raw `row_json` at `seq`, the way a newer build or a bad write would leave it. */
export function insertTestJournalRowJson(
  db: Database.Database,
  sessionId: string,
  seq: number,
  rowJson: string,
  ts = 1
): void {
  db.prepare(
    'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, liveEpoch(db, sessionId), seq, ts, rowJson)
}

export function updateTestJournalRowJson(
  db: Database.Database,
  sessionId: string,
  seq: number,
  rowJson: string
): void {
  db.prepare(
    'UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND epoch = ? AND seq = ?'
  ).run(rowJson, sessionId, liveEpoch(db, sessionId), seq)
}

export function deleteTestJournalRow(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?').run(
    sessionId,
    liveEpoch(db, sessionId),
    seq
  )
}
