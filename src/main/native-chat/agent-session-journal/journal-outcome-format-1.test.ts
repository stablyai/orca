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
  admitOutcomeFormat1,
  OUTCOME_FORMAT_1_COLLECTIONS,
  outcomeFormat1EntryParsers,
  outcomeFormat1Fields,
  outcomeFormat1Scalars
} from './journal-outcome-format-1'

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
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== 'inputEntries' && key !== 'inputCards')
  )
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
  // Every field and scalar has records here; a field or scalar added later adds its own records.
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
  // The sequence is never stored: it is the epoch's coverage.
  expect(
    new Set(stored.filter(([, field]) => field === '$').map(([, , key]) => JSON.parse(key)))
  ).toEqual(new Set(scalars.filter((scalar) => scalar !== 'lastSequence')))
  expect(stored.some(([, , , , , , deleted]) => deleted === 1)).toBe(true)

  const state = restored()
  expect(plain(state)).toEqual(fixture.expected)
  // An echo declared undefined stays present without a value.
  const echoes = [...state.itemEchoes]
  expect(echoes).toHaveLength(1)
  expect(echoes[0]?.[1]).toBeUndefined()
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

it('refuses a record of a newer format even when the epoch summary was not raised', () => {
  insertOutcome('receipts', '"client-9"', '["client-9",{}]', 3)
  expect(restoreJournal(database.db, sessionId)).toMatchObject(newer)
})

// Every key format 1 declares, at every depth, checked in as data: each must keep admitting and
// decoding as stored. Adding an optional key adds to this corpus; nothing here is edited in place.
const values = z
  .array(z.tuple([z.enum(['items', 'submissions', 'queue.cards']), z.string(), z.unknown()]))
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./__fixtures__/journal-outcome-format-1-values.json', import.meta.url),
        'utf8'
      )
    )
  )

it('admits and decodes every declared shape as stored, and refuses one key more as newer', () => {
  for (const [field, key, value] of values) {
    const json = JSON.stringify(value)
    expect(admitOutcomeFormat1({ field, key, json, deleted: false })).toEqual({
      entryKey: JSON.parse(key),
      kept: value
    })
    const decoded =
      field === 'items'
        ? outcomeFormat1Fields.items.element.parse(value)
        : outcomeFormat1EntryParsers[field].parse(value)
    expect(decoded).toEqual(value)
  }
  const [, key, item] = values[0] ?? []
  const newer = JSON.stringify(item).replace('"orcaStop":{', '"orcaStop":{"later":1,')
  expect(admitOutcomeFormat1({ field: 'items', key: key ?? '', json: newer, deleted: false })).toBe(
    'unknown'
  )
})

it('distinguishes new canonical damage from newer keys, without changing frozen format-1 admission', () => {
  const own = {
    context: { source: { epoch, sequence: 1 }, basis: 'observed', cut: 1 },
    witnessCardId: 'C'
  }
  const write = (value: unknown) => {
    database.db.prepare("DELETE FROM journal_outcomes WHERE field='inputEntries'").run()
    insertOutcome('inputEntries', '"client-1"', JSON.stringify(['client-1', value]), 2)
  }
  write(own)
  expect(restoreJournal(database.db, sessionId)).toMatchObject({ newer: null, damage: null })
  for (const context of [
    { ...own.context, cut: -1 },
    { ...own.context, cut: Number.MAX_SAFE_INTEGER + 1 },
    { ...own.context, source: { epoch: '', sequence: 1 } }
  ]) {
    write({ ...own, context })
    expect(restoreJournal(database.db, sessionId)).toMatchObject({
      newer: null,
      damage: { cause: 'unparseable-row' }
    })
  }
  write({ ...own, futureNativeKey: true })
  expect(restoreJournal(database.db, sessionId)).toMatchObject(newer)
  // A new native family is never accepted as an additive format-1 record.
  database.db.prepare("UPDATE journal_outcomes SET format=1 WHERE field='inputEntries'").run()
  expect(restoreJournal(database.db, sessionId)).toMatchObject(newer)
})
