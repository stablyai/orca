// Share one connection per test profile to match production host ownership.

import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { JournalHostDatabase } from './journal-host-database'
import { fields } from './journal-state-schema'
import { journalOutcomeSource } from './journal-outcome-format'
import { decodeJournalOutcome, type JournalOutcome } from './journal-outcome-codec'
import { applyJournalRow } from './journal-reducer'
import { restoreJournal, type JournalLoad } from './journal-open'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'
import {
  insertJournalRow,
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

export function createTrackedJournalOpener(
  fixture: { legacyInputs?: boolean } = {}
): TrackedJournalOpener {
  const journals: AgentSessionJournal[] = []
  return {
    open: async ({ stateDirectory, ...options }) => {
      if (fixture.legacyInputs) {
        seedLegacyTestJournal(openTestJournalHostDatabase(stateDirectory), options)
      }
      const { openAgentSessionJournal } = await import('./journal-store-factory')
      const journal = await openAgentSessionJournal({
        ...options,
        database: openTestJournalHostDatabase(stateDirectory)
      })
      if (fixture.legacyInputs) {
        pinTestJournalInputMode(journal)
      }
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

/** Input-parser fixtures explicitly found an epoch in the shipped input format. */
export function seedLegacyTestJournal(
  database: JournalHostDatabase,
  options: Omit<TestJournalOptions, 'stateDirectory'>
): void {
  if (
    database.readOnly ||
    readJournalSessionEpoch(database.db, options.identity.sessionId) !== null
  ) {
    return
  }
  const epoch = options.mintEpoch?.() ?? randomUUID()
  database.transaction((db) => {
    publishJournalSessionEpoch(db, options.identity, epoch)
    insertTestJournalRow(db, options.identity.sessionId, {
      kind: 'epoch',
      v: journalRowSchemaVersion([]),
      epoch,
      seq: 1,
      fence: 0,
      ts: options.now?.() ?? Date.now(),
      reason: 'session_created',
      providerHandle: agentSessionJournalProviderHandle(options.identity)
    })
  })
}

export const SAVED_BY_NEWER_ORCA = {
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' }
  }
}

export function loadTestJournal(stateDirectory: string, sessionId: string): JournalLoad | null {
  return restoreJournal(openTestJournalHostDatabase(stateDirectory).db, sessionId)
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

/** Read current canonical contributions in commit order for persisted-outcome assertions. */
export function readTestJournalOutcomes(
  db: Database.Database,
  sessionId: string
): JournalOutcome[] {
  const epoch = readJournalSessionEpoch(db, sessionId)
  const source = epoch && journalOutcomeSource(db, sessionId, epoch)
  if (!source) {
    return []
  }
  return db
    .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted FROM journal_outcomes
    WHERE generation = ? ORDER BY seq, field, entry_key`)
    .all(source.generation)
    .map(decodeJournalOutcome)
}

export function readTestQueueChanges(
  db: Database.Database,
  sessionId: string
): {
  messageId: string
  op: string
  returned: boolean
}[] {
  const seen = new Set<string>()
  return readTestJournalOutcomes(db, sessionId).flatMap((value) => {
    if (value.field !== 'queue.cards') {
      return []
    }
    if (value.deleted) {
      return [{ messageId: String(JSON.parse(value.key)), op: 'withdrawn', returned: false }]
    }
    const [messageId, card] = fields.queue.shape.cards.element.parse(JSON.parse(value.json))
    const first = !seen.has(messageId)
    seen.add(messageId)
    return [
      { messageId, op: first ? 'queued' : card.state, returned: first && card.state === 'returned' }
    ]
  })
}

/** Input fixtures stand for a chat an older build wrote and goes on writing: writes to its input
 * epoch stay input rows, as that build's writer stored them, so the input reader meets writer-made
 * rows. An epoch this build founds (rollover, replacement) is written as this build writes it. */
export function pinTestJournalInputMode(journal: AgentSessionJournal): void {
  const projection = journal['projection']
  const prepare = projection.prepare.bind(projection)
  projection.prepare = (db, rows, savedAt) => {
    const state = journal['state']
    if (journalOutcomeSource(db, state.sessionId, state.epoch)) {
      return prepare(db, rows, savedAt)
    }
    for (const row of rows) {
      insertJournalRow(db, state.sessionId, row, savedAt)
    }
    return () => {
      for (const row of rows) {
        applyJournalRow(state, row, savedAt)
      }
    }
  }
}
