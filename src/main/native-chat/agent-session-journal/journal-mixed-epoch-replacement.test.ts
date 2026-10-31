import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { journalOutcomeSource } from './journal-outcome-format'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import type { AgentSessionJournal } from './journal-store'
import { JournalWriteProjection } from './journal-write-projection'

// An existing chat this build has written to holds old input rows, the marker and records. Rewind,
// replacement and rollover found an outcome-only epoch from what the open chat holds, delete the
// retired epoch's rows whole inside that transaction, as main does, and leave its records to the
// runner's sweep; a refused replacement leaves the mixed chat as it was.
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

const db = () => openTestJournalHostDatabase(root).db
const rowsOfEpoch = (epoch: string) =>
  db().prepare('SELECT seq, row_json FROM journal_rows WHERE epoch = ? ORDER BY seq').all(epoch)
const recordsOf = (generation: number) =>
  db().prepare('SELECT * FROM journal_outcomes WHERE generation = ? ORDER BY seq').all(generation)

/** Old rows (items 0 and 1, a waiting card, a user Stop), then this build's records (item 0
 * revised, item 2, a second card). */
async function mixedChat(): Promise<AgentSessionJournal> {
  const older = createTrackedJournalOpener({ legacyInputs: true })
  const earlier = await older.open({ identity: IDENTITY, stateDirectory: root })
  await earlier.appendItem(item(0), status('first'), scope)
  await earlier.appendItem(item(1), status('second'), scope)
  await earlier.queuedMessages.insert({ messageId: 'card-old', body: message('old card') })
  await earlier.appendStopEvent({ reason: 'user-stop' }, FENCE)
  await older.closeAll()
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  await journal.appendItem(item(0), status('first, revised'), scope)
  await journal.appendItem(item(2), status('third'), scope)
  await journal.queuedMessages.insert({ messageId: 'card-new', body: message('new card') })
  const source = journalOutcomeSource(db(), IDENTITY.sessionId, journal.epoch)
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

function expectRetiredWhole(retired: { epoch: string; generation: number }, live: string) {
  expect(rowsOfEpoch(retired.epoch)).toEqual([])
  const source = journalOutcomeSource(db(), IDENTITY.sessionId, live)
  // The new epoch is outcome-only: its rows hold only the marker.
  expect(source?.prefix).toBe(0)
  expect(rowsOfEpoch(live).map((row) => JSON.parse(String(row.row_json)).kind)).toEqual([
    'outcomes'
  ])
  expect(recordsOf(retired.generation).length).toBeGreaterThan(0)
  const database = openTestJournalHostDatabase(root)
  while (sweepJournalOutcomePage(database)) {
    // Sweeps one bounded page per transaction.
  }
  expect(recordsOf(retired.generation)).toEqual([])
  expect(recordsOf(source!.generation).length).toBeGreaterThan(0)
}

it.each(['rewind', 'replacement'] as const)(
  'a %s of a mixed chat keeps what the user kept and deletes the retired epoch whole',
  async (path) => {
    const journal = await mixedChat()
    const retired = {
      epoch: journal.epoch,
      generation: journalOutcomeSource(db(), IDENTITY.sessionId, journal.epoch)!.generation
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
    expectRetiredWhole(retired, epoch)
  }
)

it('a rollover of a mixed chat keeps its queue and deletes the retired epoch whole', async () => {
  const journal = await mixedChat()
  const retired = {
    epoch: journal.epoch,
    generation: journalOutcomeSource(db(), IDENTITY.sessionId, journal.epoch)!.generation
  }
  const before = seen(journal)
  await journal.rollEpoch('unreconcilable_prefix', FENCE)
  const live = seen(journal)
  expect(live).toEqual({ ...before, items: [], stop: null })
  const epoch = journal.epoch
  expect(await reopened()).toEqual(live)
  expectRetiredWhole(retired, epoch)
})

it('a refused replacement of a mixed chat leaves its rows, records and state as they were', async () => {
  const journal = await mixedChat()
  const rows = liveTestJournalRows(db(), IDENTITY.sessionId)
  const records = db().prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()
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
  expect(liveTestJournalRows(db(), IDENTITY.sessionId)).toEqual(rows)
  expect(db().prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()).toEqual(records)
  expect(seen(journal)).toEqual(before)
  expect(await reopened()).toEqual(before)
})
