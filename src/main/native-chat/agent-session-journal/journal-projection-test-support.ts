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
import { restoreJournalAsync } from './journal-async-open'
import { encodeJournalState } from './journal-state-codec'
import { publishJournalOutcomeEpochPlan } from './journal-outcome-write'
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

export async function seedProjectionRows(
  database: JournalHostDatabase,
  rows: readonly JournalRow[]
): Promise<JournalReducerState> {
  const state = createJournalReducerState(projectionSessionId, projectionEpoch)
  await database.transaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    for (const row of rows) {
      insertTestJournalRow(db, projectionSessionId, row)
      applyJournalRow(state, row)
    }
  })
  return state
}

export async function seedOutcomeRows(
  database: JournalHostDatabase,
  rows: readonly JournalRow[]
): Promise<JournalReducerState> {
  const publication = await database.transaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    return publishJournalOutcomeEpochPlan(db, projectionSessionId, projectionEpoch, rows)
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

export async function expectProjectionMatches(
  database: JournalHostDatabase,
  state: JournalReducerState
): Promise<void> {
  const restored = await database.read(async (read) => {
    if (!(await read.source(state.sessionId, state.epoch))) {
      throw new Error('expected canonical outcomes')
    }
    return restoreJournalAsync(read, state.sessionId)
  })
  expect(restored?.damage).toBeNull()
  expect(restored?.newer).toBeNull()
  expect(restored && encodeJournalState(restored.state)).toStrictEqual(encodeJournalState(state))
}
