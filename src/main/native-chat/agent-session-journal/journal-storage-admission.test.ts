import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  SAVED_BY_NEWER_ORCA,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import { admitOutcomeFormat1 } from './journal-outcome-format-1'
import { restoreJournal } from './journal-open'
import { JournalProjectionCatchUp } from './journal-projection-catch-up'
import { finishCatchUp } from './journal-projection-test-support'
import type { JournalReducerState } from './journal-reducer'
import {
  journalEntryJson,
  journalStateCollections,
  journalStateScalars
} from './journal-state-layout'
import { readStoredQueuedMessageRow } from './queued-message-stored-row'

// Admission keeps the in-memory chat within what this build declares on every path a saved value
// takes into it, so restating that chat on a new epoch never drops a newer build's key.

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
let clock = 1_000
const inputs = createTrackedJournalOpener({ legacyInputs: true })
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-storage-admission-'))
})
afterEach(async () => {
  await inputs.closeAll()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(opener: typeof journals) {
  return opener.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${clock}`
  })
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

async function writeItems(opener: typeof journals, ordinals: number[]): Promise<string> {
  const journal = await open(opener)
  for (const ordinal of ordinals) {
    await journal.appendItem(
      item(ordinal),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `item ${ordinal}` }] },
      SCOPE
    )
  }
  await opener.closeAll()
  return journal.epoch
}

const db = () => openTestJournalHostDatabase(root).db

/** Every saved byte of the chat database: a refusal writes none of it. */
function savedBytes(): unknown {
  const tables = db()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map(({ name }) => String(name))
  return tables.map((table) => [table, db().prepare(`SELECT * FROM "${table}"`).all()])
}

/** Adds a key no build declares inside an item's first text block, as a newer build would. */
function withLaterKey(json: string): string {
  return json.replace('"type":"text",', '"type":"text","emphasis":"strong",')
}

it("refuses a newer build's record with an undeclared nested key before adopting the cache, writes nothing, and starts no epoch", async () => {
  const epoch = await writeItems(journals, [0, 1, 2])
  const database = openTestJournalHostDatabase(root)
  await finishCatchUp(new JournalProjectionCatchUp(database, IDENTITY.sessionId, epoch))
  const source = db().prepare('SELECT generation, through_seq FROM journal_outcome_epochs').get()
  const generation = Number(source?.generation)
  const through = Number(source?.through_seq)
  expect(restoreJournal(db(), IDENTITY.sessionId)?.projectionThrough).toBe(through)

  // The newer build revises item 2 with a key this build does not declare and keeps its cache.
  const itemId = 'codex:thread-1:turn-1:2'
  const latest = db()
    .prepare(`SELECT value_json FROM journal_outcomes WHERE field = 'items' AND entry_key = ?
      ORDER BY seq DESC LIMIT 1`)
    .get(JSON.stringify(itemId))
  const revised = withLaterKey(String(latest?.value_json))
  const next = through + 1
  const ordinal = (index: number) =>
    `s${String(next).padStart(16, '0')}:${String(index).padStart(16, '0')}`
  database.transaction((write) => {
    const insert = write.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, ?, ?, 1, ?, ?, 0)`)
    insert.run(generation, next, 'items', JSON.stringify(itemId), ordinal(0), revised)
    insert.run(generation, next, '$', '"lastSequence"', ordinal(1), String(next))
    write.prepare('UPDATE journal_outcome_epochs SET through_seq = ?').run(next)
    write.prepare('UPDATE journal_items SET item_json = ? WHERE item_id = ?').run(revised, itemId)
    const state = db().prepare('SELECT state_json FROM journal_state').get()
    const scalars = { ...JSON.parse(String(state?.state_json)), lastSequence: next }
    write
      .prepare('UPDATE journal_state SET through_seq = ?, state_json = ?')
      .run(next, JSON.stringify(scalars))
  })
  const before = savedBytes()

  expect(restoreJournal(db(), IDENTITY.sessionId)).toMatchObject({ newer: { sequence: 1 } })
  // No handle exists for a refused chat, so nothing can replace, roll over or rewind its epoch.
  await expect(open(journals)).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
  expect(savedBytes()).toEqual(before)
})

it.each([
  ['alone', []],
  ['with outcome records after it', [2]]
])(
  'refuses a chat whose frozen input row holds an undeclared key before folding it, %s',
  async (_name, later) => {
    await writeItems(inputs, [0, 1])
    if (later.length > 0) {
      await writeItems(journals, later)
      expect(db().prepare('SELECT COUNT(*) AS n FROM journal_outcomes').get()?.n).not.toBe(0)
    }
    const row = liveTestJournalRows(db(), IDENTITY.sessionId).find((stored) => stored.seq === 2)
    updateTestJournalRowJson(db(), IDENTITY.sessionId, 2, withLaterKey(row?.rowJson ?? ''))
    const before = savedBytes()
    await expect(open(journals)).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    expect(savedBytes()).toEqual(before)
  }
)

it('leaves a legacy queued card whose saved body holds an undeclared key on disk, never adopted', () => {
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] }
  const row = (saved: unknown) => ({
    message_id: 'card-1',
    position: 1,
    body_json: JSON.stringify(saved),
    fingerprint: 'f',
    state: 'waiting',
    hold_reason: null,
    returned_reason: null,
    returned_rejection: null,
    consumed_as: null,
    queued_epoch: 'epoch-1',
    queued_sequence: 2,
    options_json: '{"model":"m","later":"x"}'
  })
  // Options keep their legacy meaning: a choice this build does not use is ignored.
  expect(readStoredQueuedMessageRow(row(body))).toMatchObject({ messageId: 'card-1', body })
  expect(readStoredQueuedMessageRow(row(body))?.options).toEqual({ model: 'm' })
  const later = { ...body, blocks: [{ type: 'text', text: 'later', emphasis: 'strong' }] }
  expect(readStoredQueuedMessageRow(row(later))).toBeNull()
})

// Input rows as builds before outcome records wrote them, checked in with the chat they fold into.
// A reducer change that reads them differently fails here: version the prefix fold, never edit this.
const prefix = z
  .object({
    sessionId: z.string(),
    epoch: z.string(),
    rows: z.array(z.string()),
    expected: z.record(z.string(), z.unknown())
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./__fixtures__/journal-input-prefix.json', import.meta.url), 'utf8')
    )
  )

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

it('folds the checked-in input rows into the same chat, every value of which storage declares', () => {
  const database = openTestJournalHostDatabase(root)
  database.transaction((write) => {
    publishTestJournalEpoch(write, prefix.sessionId, prefix.epoch)
    for (const [index, json] of prefix.rows.entries()) {
      insertTestJournalRowJson(write, prefix.sessionId, index + 1, json, 1_001 + index)
    }
  })
  const loaded = restoreJournal(db(), prefix.sessionId)
  expect(loaded).toMatchObject({ newer: null, damage: null })
  if (!loaded) {
    throw new Error('missing prefix chat')
  }
  expect(plain(loaded.state)).toEqual(prefix.expected)
  // What restating this chat on a new epoch would store, admitted as this build stores it.
  const stored = [
    ...Object.entries(JSON.parse(journalStateScalars(loaded.state))).map(([key, value]) => ({
      field: '$',
      key: JSON.stringify(key),
      json: JSON.stringify(value)
    })),
    ...[...loaded.state.items].map(([key, value]) => ({
      field: 'items',
      key: JSON.stringify(key),
      json: JSON.stringify(value)
    })),
    ...journalStateCollections(loaded.state).flatMap(({ path, entries }) =>
      [...(path === 'items' ? [] : entries)].map(([key, value]) => ({
        field: path,
        key: JSON.stringify(key),
        json: journalEntryJson(key, value)
      }))
    )
  ]
  expect(stored.length).toBeGreaterThan(20)
  for (const value of stored) {
    expect(admitOutcomeFormat1({ ...value, deleted: false })).toBeUndefined()
  }
})
