import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  seedLegacyTestJournal
} from './journal-host-database-test-support'
import type { JournalRow } from './journal-row-schema'
import { journalOutcomeSource } from './journal-outcome-format'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import type { AgentSessionJournal } from './journal-store'
import { JournalWriteProjection } from './journal-write-projection'

// Logical replacements retain the physical prefix and generation; failed writes retain both views.
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-mixed-replacement',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const FENCE = 1
const scope = { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
const item = (ordinal: number): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal
})
const status = (text: string): AgentJournalItemBody => ({ kind: 'status', text })
const message = (text: string) => ({
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text }]
})

let root: string
const journals = createTrackedJournalOpener()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-mixed-replacement-'))
  // Every commit restores the chat from disk and fails the write if it differs from live.
  JournalWriteProjection.verifyEachCommit = true
})
afterEach(async () => {
  JournalWriteProjection.verifyEachCommit = false
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const db = async () => (await openTestJournalHostDatabase(root)).db
const rowsOfEpoch = async (epoch: string) =>
  (await db())
    .prepare('SELECT seq, row_json FROM journal_rows WHERE epoch = ? ORDER BY seq')
    .all(epoch)
const recordsOf = async (generation: number) =>
  (await db())
    .prepare('SELECT * FROM journal_outcomes WHERE generation = ? ORDER BY seq')
    .all(generation)

/** Old rows (items 0 and 1, a waiting card, a user Stop), then this build's records (item 0
 * revised, item 2, a second card). */
async function mixedChat(): Promise<AgentSessionJournal> {
  // Freeze the old writer's rows before opening a current native coordinate owner.
  const database = await openTestJournalHostDatabase(root)
  const epoch = 'old-input-epoch'
  seedLegacyTestJournal(database, { identity: IDENTITY, mintEpoch: () => epoch, now: () => 1000 })
  const base = { v: 2, epoch, fence: FENCE, ts: 1000 }
  const prefix = [
    ...[status('first'), status('second')].map((body, ordinal): JournalRow => ({
      ...base,
      kind: 'item',
      seq: ordinal + 2,
      itemId: agentJournalItemKey(item(ordinal)),
      revision: 1,
      body,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })),
    {
      ...base,
      v: 4,
      kind: 'queue',
      seq: 4,
      messageId: 'card-old',
      change: {
        op: 'queued',
        body: message('old card'),
        position: 0,
        queuedAt: { epoch, sequence: 4 }
      }
    },
    {
      ...base,
      kind: 'tombstone',
      seq: 5,
      itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'stop-event' }),
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1000 }
    }
  ] satisfies JournalRow[]
  database.fixtureTransaction((db) => {
    for (const row of prefix) {
      insertTestJournalRow(db, IDENTITY.sessionId, row)
    }
  })
  expect(
    (await rowsOfEpoch(epoch)).slice(1).map((row) => JSON.parse(String(row.row_json)))
  ).toEqual(prefix)
  expect(journalOutcomeSource(await db(), IDENTITY.sessionId, epoch)).toBeNull()
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  expect(seen(journal)).toEqual({
    items: [status('first'), status('second')],
    cards: [['card-old', message('old card'), 'waiting']],
    stop: 'user-stop'
  })
  await journal.appendItem(item(0), status('first, revised'), scope)
  const converted = journalOutcomeSource(await db(), IDENTITY.sessionId, epoch)
  expect(converted).toMatchObject({ prefix: 5, format: 2 })
  expect(
    (await db())
      .prepare(`SELECT entry_key FROM journal_outcomes
    WHERE generation = ? AND field = 'inputCards' AND deleted = 0`)
      .all(converted!.generation)
  ).toEqual([{ entry_key: JSON.stringify('card-old') }])
  await journal.appendItem(item(2), status('third'), scope)
  await journal.queuedMessages.insert({ messageId: 'card-new', body: message('new card') })
  const source = journalOutcomeSource(await db(), IDENTITY.sessionId, journal.epoch)
  expect(source?.prefix).toBeGreaterThan(0)
  return journal
}

/** What a user sees of the chat: its items, sends, queue and pause. */
function seen(journal: AgentSessionJournal) {
  return {
    items: journal.snapshot().items.map((entry) => entry.body),
    cards: journal.queuedMessages.list().map((card) => [card.messageId, card.body, card.state]),
    stop: journal.queuedMessages.userStopInForce()?.event.reason ?? null
  }
}

async function reopened() {
  await journals.closeAll()
  return seen(await journals.open({ identity: IDENTITY, stateDirectory: root }))
}

async function expectPhysicalRetained(
  retired: { epoch: string; generation: number; rows: Awaited<ReturnType<typeof rowsOfEpoch>> },
  live: string
) {
  expect(live).not.toBe(retired.epoch)
  expect(await rowsOfEpoch(retired.epoch)).toEqual(retired.rows)
  const source = journalOutcomeSource(await db(), IDENTITY.sessionId, retired.epoch)!
  expect(source.generation).toBe(retired.generation)
  expect(source.prefix).toBe(5)
  expect((await recordsOf(retired.generation)).length).toBeGreaterThan(0)
  const database = await openTestJournalHostDatabase(root)
  while (await sweepJournalOutcomePage(database)) {
    // Maintenance must not retire the active physical generation.
  }
  expect(await rowsOfEpoch(retired.epoch)).toEqual(retired.rows)
  expect((await recordsOf(source.generation)).length).toBeGreaterThan(0)
}

it.each(['rewind', 'replacement'] as const)(
  'a %s of a mixed chat keeps what the user kept and retains the physical prefix',
  async (path) => {
    const journal = await mixedChat()
    const retired = {
      epoch: journal.epoch,
      generation: journalOutcomeSource(await db(), IDENTITY.sessionId, journal.epoch)!.generation,
      rows: await rowsOfEpoch(journal.epoch)
    }
    const kept = [
      { identity: item(0), body: status('first, revised'), ownerFence: FENCE },
      { identity: item(2), body: status('third'), ownerFence: FENCE }
    ]
    await journal.replaceEpochItems(
      path === 'rewind' ? 'handle_forked' : 'legacy_import',
      FENCE,
      kept
    )
    const live = seen(journal)
    expect(live).toEqual({
      items: [status('first, revised'), status('third')],
      cards: [
        ['card-old', message('old card'), 'waiting'],
        ['card-new', message('new card'), 'waiting']
      ],
      stop: 'user-stop'
    })
    const epoch = journal.epoch
    expect(epoch).not.toBe(retired.epoch)
    expect(await reopened()).toEqual(live)
    await expectPhysicalRetained(retired, epoch)
  }
)

it('a rollover of a mixed chat keeps its queue and retains the physical prefix', async () => {
  const journal = await mixedChat()
  const retired = {
    epoch: journal.epoch,
    generation: journalOutcomeSource(await db(), IDENTITY.sessionId, journal.epoch)!.generation,
    rows: await rowsOfEpoch(journal.epoch)
  }
  const before = seen(journal)
  await journal.rollEpoch('unreconcilable_prefix', FENCE)
  const live = seen(journal)
  expect(live).toEqual({ ...before, items: [] })
  const epoch = journal.epoch
  expect(await reopened()).toEqual(live)
  await expectPhysicalRetained(retired, epoch)
})

it('a refused replacement of a mixed chat leaves its rows, records and state as they were', async () => {
  const journal = await mixedChat()
  const rows = liveTestJournalRows(await db(), IDENTITY.sessionId)
  const records = (await db()).prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()
  const before = seen(journal)
  const unreadable: AgentJournalItemBody = {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: null, callId: '   ' }]
  }
  await expect(
    journal.replaceEpochItems('handle_forked', FENCE, [
      { identity: item(0), body: status('first, revised'), ownerFence: FENCE },
      { identity: item(5), body: unreadable, ownerFence: FENCE }
    ])
  ).rejects.toMatchObject({ code: 'journal_row_rejected' })
  expect(liveTestJournalRows(await db(), IDENTITY.sessionId)).toEqual(rows)
  expect((await db()).prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()).toEqual(
    records
  )
  expect(seen(journal)).toEqual(before)
  expect(await reopened()).toEqual(before)
})
