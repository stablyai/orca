import { expect } from 'vitest'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { JournalWriteProjection } from './journal-write-projection'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { restoreJournal } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import { journalOutcomeSource } from './journal-outcome-format'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { insertTestJournalRow, publishTestJournalEpoch } from './journal-host-database-test-support'
import type { JournalRow } from './journal-row-schema'

export const projectionSessionId = 'session-1'
export const projectionEpoch = 'epoch-1'
export const projectionBase = (seq: number) => ({
  v: 4,
  epoch: projectionEpoch,
  seq,
  ts: 1_000 + seq,
  fence: 1
})
export const projectionEpochRow: JournalRow = {
  ...projectionBase(1),
  kind: 'epoch',
  reason: 'session_created',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

export function seedProjectionRows(
  database: JournalHostDatabase,
  rows: readonly JournalRow[]
): JournalReducerState {
  const state = createJournalReducerState(projectionSessionId, projectionEpoch)
  database.transaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    for (const row of rows) {
      insertTestJournalRow(db, projectionSessionId, row)
      applyJournalRow(state, row)
    }
  })
  return state
}

export function seedOutcomeRows(
  database: JournalHostDatabase,
  rows: readonly JournalRow[]
): JournalReducerState {
  const publication = database.transaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    return publishJournalOutcomeEpoch(db, projectionSessionId, projectionEpoch, rows)
  })
  return publication.adopt()
}

export function projectionWriter(database: JournalHostDatabase, initial: JournalReducerState) {
  let state = initial
  const queue = new JournalWriteQueue(state.sessionId)
  const projection = new JournalWriteProjection({
    database,
    state: () => state,
    adopt: (next) => {
      state = next
    }
  })
  const writer = new JournalRowWriter({
    database: () => database,
    sessionId: state.sessionId,
    now: () => 10_000,
    serialize: (run) => queue.serialize(run),
    readOnly: () => false,
    highestFence: () => state.highestFence,
    nextSequence: () => state.lastSequence + 1,
    prepare: (db, rows, savedAt) => projection.prepare(db, rows, savedAt),
    commit: () => undefined
  })
  return { writer, projection, state: () => state, queue }
}

export function expectProjectionMatches(
  database: JournalHostDatabase,
  state: JournalReducerState
): void {
  const source = journalOutcomeSource(database.db, state.sessionId, state.epoch)
  if (!source) {
    throw new Error('expected canonical outcomes')
  }
  const restored = restoreJournal(database.db, state.sessionId)
  expect(restored?.damage).toBeNull()
  expect(restored?.newer).toBeNull()
  expect(restored && encodeJournalState(restored.state)).toStrictEqual(encodeJournalState(state))
}
