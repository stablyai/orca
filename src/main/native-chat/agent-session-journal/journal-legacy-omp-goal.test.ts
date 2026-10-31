import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRowJson,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { restoreJournal } from './journal-open'
import { prepareJournalOutcomeWrite } from './journal-outcome-write'

const sessionId = 'omp-legacy-goal'
const epoch = 'epoch-1'
const goal = {
  id: 'legacy-native-goal-id',
  objective: 'Finish the task',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 120,
  timeUsedSeconds: 30,
  createdAt: 1,
  updatedAt: 2
}
const base = { v: 2, epoch, fence: 1, ts: 1 }
let root: string
let database: JournalHostDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-omp-goal-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => {
    publishTestJournalEpoch(db, sessionId, epoch)
    insertTestJournalRowJson(
      db,
      sessionId,
      1,
      JSON.stringify({
        ...base,
        seq: 1,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'opaque', agent: 'omp', value: 'native-session' }
      })
    )
  })
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function insertGoal(value: unknown): void {
  insertTestJournalRowJson(
    database.db,
    sessionId,
    2,
    JSON.stringify({
      ...base,
      seq: 2,
      kind: 'item',
      itemId: 'legacy-goal',
      revision: 1,
      body: { kind: 'status', text: 'Goal: Finish the task (active)', threadGoal: value }
    })
  )
}

it('reopens legacy OMP goals and preserves their native ID across outcome writes', () => {
  insertGoal({ state: 'set', goal })
  const loaded = restoreJournal(database.db, sessionId)
  expect(loaded).toMatchObject({ newer: null, damage: null })
  if (!loaded) {
    throw new Error('missing legacy chat')
  }
  const item = loaded.state.items.get('legacy-goal')
  expect(item?.body).toMatchObject({ threadGoal: { state: 'set', goal } })
  if (!item) {
    throw new Error('missing legacy goal')
  }

  const transition = database.transaction((db) =>
    prepareJournalOutcomeWrite(
      db,
      loaded.state,
      [
        {
          ...base,
          seq: 3,
          kind: 'item',
          itemId: 'legacy-goal',
          revision: 2,
          body: item.body
        }
      ],
      3
    )
  )
  transition.adopt()
  const reopened = restoreJournal(database.db, sessionId)
  expect(reopened).toMatchObject({ newer: null, damage: null })
  expect(reopened?.state.lastSequence).toBe(3)
  expect(reopened?.state.items.get('legacy-goal')?.body).toEqual(item?.body)
})

it('still refuses undeclared future goal fields', () => {
  insertGoal({ state: 'set', goal: { ...goal, futureGoalState: 'unknown' } })
  expect(restoreJournal(database.db, sessionId)).toMatchObject({
    newer: { sequence: 2 },
    damage: null
  })
})

it('still refuses unknown future goal states', () => {
  insertGoal({ state: 'future-state', goal })
  expect(restoreJournal(database.db, sessionId)).toMatchObject({
    newer: { sequence: 2 },
    damage: null
  })
})
