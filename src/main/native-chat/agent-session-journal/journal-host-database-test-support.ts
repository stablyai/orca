// Share one connection per test profile to match production host ownership.

import { resolve } from 'node:path'
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

const opened = new Map<string, JournalHostDatabase>()

export function openTestJournalHostDatabase(stateDirectory: string): JournalHostDatabase {
  const directory = resolve(stateDirectory)
  const existing = opened.get(directory)
  if (existing && !existing.isClosed) {
    return existing
  }
  const database = JournalHostDatabase.open(directory)
  opened.set(directory, database)
  return database
}

export async function closeTestJournalHostDatabase(stateDirectory: string): Promise<void> {
  const directory = resolve(stateDirectory)
  await opened.get(directory)?.close()
  opened.delete(directory)
}

export async function closeTestJournalHostDatabases(): Promise<void> {
  for (const database of opened.values()) {
    await database.close()
  }
  opened.clear()
}

export type TestJournalOptions = Omit<AgentSessionJournalOptions, 'database'> & {
  stateDirectory: string
}

export type TrackedJournalOpener = {
  open: (options: TestJournalOptions) => Promise<AgentSessionJournal>
  track: <T extends AgentSessionJournal>(journal: T) => T
  closeAll: () => Promise<void>
}

export function createTrackedJournalOpener(): TrackedJournalOpener {
  const journals: AgentSessionJournal[] = []
  return {
    open: async ({ stateDirectory, ...options }) => {
      const { openAgentSessionJournal } = await import('./journal-store-factory')
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
      await closeTestJournalHostDatabases()
    }
  }
}

export const SAVED_BY_NEWER_ORCA = {
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' }
  }
}

export function loadTestJournal(stateDirectory: string, sessionId: string): JournalLoad | null {
  return replayJournal(openTestJournalHostDatabase(stateDirectory).db, sessionId)
}

function liveEpoch(db: Database.Database, sessionId: string): string {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return epoch
}

export function publishTestJournalEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string
): void {
  publishJournalSessionEpoch(db, { sessionId, workspaceId: 'ws-1' }, epoch)
}

export function readTestJournalRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalStoredRow[] {
  return readJournalSessionEpoch(db, sessionId) === epoch
    ? [...iterateJournalEpochRows(db, sessionId, epoch)]
    : []
}

export function liveTestJournalRows(db: Database.Database, sessionId: string): JournalStoredRow[] {
  const epoch = readJournalSessionEpoch(db, sessionId)
  return epoch === null ? [] : [...iterateJournalEpochRows(db, sessionId, epoch)]
}

export function insertTestJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): void {
  insertTestJournalRowJson(db, sessionId, row.seq, serializeJournalRow(row), row.ts)
}

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
