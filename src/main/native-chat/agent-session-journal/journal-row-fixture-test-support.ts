import { assertTestJournalHistoricalInputs } from './journal-historical-inputs.test-support'
import { buildJournalQueueRow, type JournalQueueChange } from './journal-queue-events'
import { applyJournalRow } from './journal-reducer'
import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalProviderHandle } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'
import {
  iterateJournalEpochRows,
  iterateJournalEpochRowsAsync,
  publishJournalSessionEpoch,
  readJournalSessionEpoch,
  type JournalStoredRow
} from './journal-row-table'
import { JournalPersistencePlan } from './journal-persistence-plan'
import { JournalHostDatabase } from './journal-host-database'
import type { JournalReadConnection } from './journal-sql-owner'
import { mutateTestJournalFixture as mutateFixture } from './journal-drained-fixture-test-support'
import type Database from '../../sqlite/sync-database'

function liveEpoch(db: Database.Database, sessionId: string): string {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    throw new Error(`no journal for ${sessionId}`)
  }
  return epoch
}

export function publishTestJournalEpoch(
  db: Database.Database | JournalPersistencePlan,
  sessionId: string,
  epoch: string,
  workspaceId = 'ws-1'
): void {
  if (db instanceof JournalPersistencePlan) {
    db.add({ kind: 'epoch', sessionId, workspaceId, epoch })
  } else {
    publishJournalSessionEpoch(db, { sessionId, workspaceId }, epoch)
  }
}

export type TestJournalReader = Database.Database | JournalReadConnection | JournalHostDatabase

async function readFixture<T>(
  db: TestJournalReader,
  run: (read: Database.Database | JournalReadConnection) => Promise<T>
): Promise<T> {
  return db instanceof JournalHostDatabase ? db.read(run) : run(db)
}

export async function readTestJournalRows(
  db: TestJournalReader,
  sessionId: string,
  epoch: string
): Promise<JournalStoredRow[]> {
  return readFixture(db, async (read) => {
    const current = (
      await read.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get(sessionId)
    )?.epoch
    if (current !== epoch) {
      return []
    }
    if ('pages' in read) {
      const rows: JournalStoredRow[] = []
      for await (const page of iterateJournalEpochRowsAsync(read, sessionId, epoch)) {
        rows.push(...page)
      }
      return rows
    }
    return [...iterateJournalEpochRows(read, sessionId, epoch)]
  })
}

export async function liveTestJournalRows(
  db: TestJournalReader,
  sessionId: string
): Promise<JournalStoredRow[]> {
  return readFixture(db, async (read) => {
    const epoch = (
      await read.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get(sessionId)
    )?.epoch
    return typeof epoch === 'string' ? readTestJournalRows(read, sessionId, epoch) : []
  })
}

export function insertTestJournalRow(
  db: Database.Database | JournalPersistencePlan,
  sessionId: string,
  row: JournalRow
): void {
  if (db instanceof JournalPersistencePlan) {
    db.add({
      kind: 'rows',
      sessionId,
      rows: [{ epoch: row.epoch, seq: row.seq, json: serializeJournalRow(row), savedAt: row.ts }]
    })
  } else {
    insertTestJournalRowJson(db, sessionId, row.seq, serializeJournalRow(row), row.ts)
  }
}

export function insertTestJournalRowJson(
  db: Database.Database | JournalPersistencePlan,
  sessionId: string,
  seq: number,
  rowJson: string,
  ts = 1,
  epoch?: string
): void {
  if (db instanceof JournalPersistencePlan) {
    if (!epoch) {
      throw new Error('Raw planned journal fixture requires its exact epoch')
    }
    db.add({ kind: 'rows', sessionId, rows: [{ epoch, seq, savedAt: ts, json: rowJson }] })
    return
  }
  db.prepare(
    'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, liveEpoch(db, sessionId), seq, ts, rowJson)
}

export function updateTestJournalRowJson(
  db: Database.Database | JournalHostDatabase,
  sessionId: string,
  seq: number,
  rowJson: string
): void | Promise<void> {
  if (db instanceof JournalHostDatabase) {
    return mutateFixture(db, (fixture) => {
      updateTestJournalRowJson(fixture, sessionId, seq, rowJson)
    })
  }
  db.prepare(
    'UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND epoch = ? AND seq = ?'
  ).run(rowJson, sessionId, liveEpoch(db, sessionId), seq)
}

export function deleteTestJournalRow(
  db: Database.Database | JournalHostDatabase,
  sessionId: string,
  seq: number
): void | Promise<void> {
  if (db instanceof JournalHostDatabase) {
    return mutateFixture(db, (fixture) => {
      deleteTestJournalRow(fixture, sessionId, seq)
    })
  }
  db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?').run(
    sessionId,
    liveEpoch(db, sessionId),
    seq
  )
}

/** Unannotated submissions and terminal rows emitted by the legacy writer in one source epoch. */
export function writeTestLegacyTerminalGaps(
  db: Database.Database | JournalPersistencePlan,
  sessionId: string,
  base: {
    epoch: string
    sequence: number
    fence: number
    providerHandle: AgentSessionJournalProviderHandle
  },
  n: number
): number {
  let seq = base.sequence
  const row = () => ({ v: 3, epoch: base.epoch, seq: ++seq, fence: base.fence, ts: 1 })
  for (let i = 0; i < n; i++) {
    const id = `terminal-${i}`
    insertTestJournalRow(db, sessionId, {
      ...row(),
      kind: 'submission',
      clientMessageId: id,
      payloadFingerprint: id,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      providerHandle: base.providerHandle,
      handoverRecorded: true,
      origin: 'client'
    })
    insertTestJournalRow(db, sessionId, {
      ...row(),
      kind: 'dispatch',
      clientMessageId: id,
      state: 'rejected',
      providerItemId: null,
      reason: 'not sent'
    })
  }
  return seq
}

/** Persist a prior-build queue row verbatim, then replay it through the production fold. */
export async function appendTestJournalQueueRow(
  db: JournalPersistencePlan | JournalHostDatabase,
  journal: AgentSessionJournal,
  messageId: string,
  change: JournalQueueChange
): Promise<void> {
  if (db instanceof JournalHostDatabase) {
    await db.transaction(
      async (plan) => {
        const state = journal['state']
        await assertTestJournalHistoricalInputs(plan, journal)
        const row = buildJournalQueueRow(
          state,
          messageId,
          change,
          state.lastSequence + 1,
          Date.now()
        )
        insertTestJournalRow(plan, state.sessionId, row)
        return row
      },
      false,
      (row) => {
        applyJournalRow(journal['state'], row)
      }
    )
    return
  }
  const state = journal['state']
  await assertTestJournalHistoricalInputs(db, journal)
  const row = buildJournalQueueRow(state, messageId, change, state.lastSequence + 1, Date.now())
  insertTestJournalRow(db, state.sessionId, row)
  applyJournalRow(state, row)
}
