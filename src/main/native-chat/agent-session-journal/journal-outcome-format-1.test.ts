import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRowJson,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { restoreJournal } from './journal-open'
import type { JournalReducerState } from './journal-reducer'
import {
  OUTCOME_FORMAT_1_COLLECTIONS,
  outcomeFormat1Scalars,
  outcomeFormat1Stored,
  outcomeFormat1StoredScalars
} from './journal-outcome-format-1'
import { JournalProjectionCatchUp } from './journal-projection-catch-up'
import { finishCatchUp } from './journal-projection-test-support'
import { JOURNAL_STATE_CODEC_VERSION } from './journal-state-codec'

// Rows a format-1 build wrote, checked in as data: this build must read them, and every later one.
const fixture = z
  .object({
    sessionId: z.string(),
    epoch: z.string(),
    through: z.number(),
    marker: z.string(),
    outcomes: z.array(
      z.tuple([z.number(), z.string(), z.string(), z.number(), z.string(), z.string(), z.number()])
    ),
    expected: z.record(z.string(), z.unknown())
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./__fixtures__/journal-outcome-format-1.json', import.meta.url), 'utf8')
    )
  )
const { sessionId, epoch } = fixture
const GENERATION = 7

let root: string
let database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-format-1-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => {
    publishTestJournalEpoch(db, sessionId, epoch)
    insertTestJournalRowJson(db, sessionId, 1, fixture.marker)
    db.prepare(`INSERT INTO journal_outcome_generations (generation, session_id, epoch)
      VALUES (?, ?, ?)`).run(GENERATION, sessionId, epoch)
    db.prepare(`INSERT INTO journal_outcome_epochs
      (session_id, epoch, generation, format, through_seq, prefix_seq) VALUES (?, ?, ?, 1, ?, 0)`).run(
      sessionId,
      epoch,
      GENERATION,
      fixture.through
    )
    const insert = db.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const outcome of fixture.outcomes) {
      insert.run(GENERATION, ...outcome)
    }
  })
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function plain(state: JournalReducerState): unknown {
  const fields: Record<string, unknown> = { ...state }
  return JSON.parse(
    JSON.stringify({
      ...Object.fromEntries(
        Object.entries(fields).map(([field, value]) => [
          field,
          value instanceof Map || value instanceof Set ? [...value] : value
        ])
      ),
      derivedTurnScope: state.derivedTurnScope.snapshot(),
      queue: { revision: state.queue.revision, cards: [...state.queue.cards] }
    })
  )
}

function restored(): JournalReducerState {
  const loaded = restoreJournal(database.db, sessionId)
  expect(loaded).toMatchObject({ newer: null, damage: null })
  if (!loaded) {
    throw new Error('missing fixture chat')
  }
  return loaded.state
}

it('reads the checked-in format-1 outcomes into the same chat, every field and scalar included', () => {
  // A new field or scalar is a new format: add its own fixture rather than editing this one.
  expect(OUTCOME_FORMAT_1_COLLECTIONS).toEqual([
    'items',
    'itemFences',
    'itemExecutionOwners',
    'providerActivityAt',
    'tombstones',
    'removedTurnIds',
    'submissions',
    'receipts',
    'aliases',
    'itemEchoes',
    'appliedSettlementIds',
    'stoppedHistoryCarried',
    'queuedHandOffPlaces',
    'normalizedHandOffs',
    'queue.cards'
  ])
  const scalars = Object.keys(outcomeFormat1Scalars.shape)
  expect(scalars).toEqual([
    'sessionId',
    'epoch',
    'lastSequence',
    'lastActivityAt',
    'oldestSequence',
    'highestFence',
    'derivedTurnScope',
    'latestAcceptedTurnSequence',
    'queuePauseMarks',
    'historyOrigin',
    'queue'
  ])
  const stored = fixture.outcomes
  expect(new Set(stored.map(([, field]) => field))).toEqual(
    new Set(['$', ...OUTCOME_FORMAT_1_COLLECTIONS])
  )
  expect(
    new Set(stored.filter(([, field]) => field === '$').map(([, , key]) => JSON.parse(key)))
  ).toEqual(new Set(scalars))
  expect(stored.some(([, , , , , , deleted]) => deleted === 1)).toBe(true)

  const state = restored()
  expect(plain(state)).toEqual(fixture.expected)
  // An echo declared undefined stays present without a value.
  const echoes = [...state.itemEchoes]
  expect(echoes).toHaveLength(1)
  expect(echoes[0]?.[1]).toBeUndefined()
})

it('rebuilds only the disposable cache when its codec changes, leaving the outcomes as stored', async () => {
  await finishCatchUp(new JournalProjectionCatchUp(database, sessionId, epoch))
  const outcomes = () =>
    database.db.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
  const before = outcomes()
  database.db
    .prepare('UPDATE journal_state SET version = ? WHERE session_id = ?')
    .run(JOURNAL_STATE_CODEC_VERSION + 1, sessionId)

  expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(0)
  expect(plain(restored())).toEqual(fixture.expected)
  await finishCatchUp(new JournalProjectionCatchUp(database, sessionId, epoch))
  expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(fixture.through)
  expect(plain(restored())).toEqual(fixture.expected)
  expect(outcomes()).toEqual(before)
})

function insertOutcome(field: string, key: string, json: string, format = 1): void {
  database.db
    .prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, ?, ?, ?, 's0000000000000021:0000000000000099', ?, 0)`)
    .run(GENERATION, fixture.through, field, key, format, json)
}

const newer = { newer: { sequence: 1 }, damage: null }

it('refuses a field format 1 does not define as written by a newer Orca', () => {
  insertOutcome('futureField', '"k"', '["k",1]')
  expect(restoreJournal(database.db, sessionId)).toMatchObject(newer)
})

it('refuses a newer chat before using a cache that would otherwise match', async () => {
  await finishCatchUp(new JournalProjectionCatchUp(database, sessionId, epoch))
  expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(fixture.through)
  insertOutcome('receipts', '"client-9"', '["client-9",{}]', 2)
  database.db.prepare('UPDATE journal_outcome_epochs SET format = 2').run()

  expect(restoreJournal(database.db, sessionId)).toMatchObject(newer)
})

it('refuses a record of a newer format even when the epoch summary was not raised', () => {
  insertOutcome('receipts', '"client-9"', '["client-9",{}]', 2)
  expect(restoreJournal(database.db, sessionId)).toMatchObject(newer)
})

it('keeps the stored format 1 schemas exactly as they shipped', () => {
  // These schemas define what format 1 records mean. Any change here, including in a shared schema
  // they use, is a new format with its own records and decoder: never edit format 1 in place.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries({ ...outcomeFormat1Stored, $: outcomeFormat1StoredScalars }).map(
          ([field, schema]) => [field, z.toJSONSchema(schema, { unrepresentable: 'any' })]
        )
      )
    )
    .digest('hex')
  expect(fingerprint).toBe('21fac800b984d60917e6df11b047782abe8050174f050ef13bee28e0d96c6fe7')
})
