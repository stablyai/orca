import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { createJournalReducerState } from './journal-reducer'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

function item(itemId: string, text = 'saved'): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    itemId,
    body: { kind: 'status', text },
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

const SESSION = 'repeated-items'
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal
const options = () => ({
  identity: {
    sessionId: SESSION,
    workspaceId: 'folder',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread')
  },
  stateDirectory: root,
  now: () => 1_000
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-repeated-items-'))
  journal = await journals.open(options())
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it.each(['within chunk', 'across chunks', 'oversized first', 'oversized last'] as const)(
  'folds repeated direct mutations in order %s through SQLite',
  async (placement) => {
    const oversized = 'x'.repeat(1_500_001)
    const first = placement === 'oversized first' ? oversized : 'first'
    const last = placement === 'oversized last' ? oversized : 'last'
    const mutations = [
      item('saved', first),
      ...(placement === 'across chunks'
        ? Array.from({ length: 199 }, (_, index) => item(`filler-${index}`))
        : []),
      item('saved', last)
    ]
    const commits = vi.fn()
    journal.observeCommits(commits)
    const input = { settlementId: 'settlement', fence: 8, mutations }
    const before = journal.cursor().sequence
    await journal.appendLifecycleBatch(input)
    expect(commits).toHaveBeenCalledTimes(1)
    const { db } = openTestJournalHostDatabase(root)
    const rows = liveTestJournalRows(db, SESSION).flatMap((stored) => {
      const parsed = parseJournalRow(stored.rowJson)
      if (!parsed.ok) {
        throw new Error('test row was not admitted')
      }
      return parsed.row.seq > before ? [parsed.row] : []
    })
    const written = rows.flatMap((row) =>
      row.kind === 'lifecycle-batch' ? row.mutations : row.kind === 'item' ? [row] : []
    )
    expect(written).toHaveLength(mutations.length)
    expect(written.filter((mutation) => mutation.itemId === 'saved')).toMatchObject([
      { revision: 1, body: { text: first } },
      { revision: 2, body: { text: last } }
    ])
    expect(rows).toHaveLength(placement === 'within chunk' ? 1 : 2)
    expect(journal.snapshot().items).toHaveLength(mutations.length - 1)
    expect(journal.itemBody('saved')).toEqual({ kind: 'status', text: last })
    const settled = journal.snapshot()
    await journal.appendLifecycleBatch(input)
    expect(journal.snapshot()).toEqual(settled)
    expect(commits).toHaveBeenCalledTimes(1)
    await journal.close()
    journal = await journals.open(options())
    expect(journal.snapshot()).toEqual(settled)
  }
)

it('does not skip an oversized repeat matching the saved body after an earlier planned change', async () => {
  const saved = { kind: 'status' as const, text: 'x'.repeat(1_500_001) }
  await journal.appendLifecycleBatch({
    settlementId: 'seed-saved',
    fence: 8,
    mutations: [item('saved', saved.text)]
  })
  await journal.appendLifecycleBatch({
    settlementId: 'restore-saved',
    fence: 8,
    mutations: [item('saved', 'changed'), item('saved', saved.text)]
  })
  expect(journal.snapshot().items).toMatchObject([{ itemId: 'saved', revision: 3, body: saved }])
})

it('advances alias and tombstone repeats across rows before re-adding the item', async () => {
  const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'turn', ordinal: 0 }
  await journal.appendSubmission({
    clientMessageId: 'saved',
    payloadFingerprint: 'fp',
    fence: 8,
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  await journal.resolveDispatch({
    clientMessageId: 'saved',
    state: 'accepted',
    providerIdentity: identity,
    fence: 8
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'saved' },
    { kind: 'status', text: 'seeded' },
    { fence: 8, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendLifecycleBatch({
    settlementId: 'alias-repeats',
    fence: 8,
    mutations: [
      item('orca:saved', 'first'),
      ...Array.from({ length: 199 }, (_, index) => item(`filler-${index}`)),
      { kind: 'tombstone', identity },
      item('orca:saved', 'last')
    ]
  })
  expect(journal.snapshot().items.find((row) => row.itemId === 'orca:saved')).toMatchObject({
    revision: 4,
    body: { text: 'last' }
  })
})

describe('resolved lifecycle planning', () => {
  it.each(['chunks', 'oversized', 'alias'] as const)(
    'rejects repeated items across %s before any row is written',
    (repeatedAs) => {
      const state = createJournalReducerState('session', 'epoch')
      state.aliases.set('alias', 'saved')
      const rows: JournalRow[] = []
      const appender = new JournalLifecycleBatchAppender({
        state: () => state,
        cursor: () => ({ epoch: state.epoch, sequence: state.lastSequence }),
        enqueueRows: async (plan) => {
          const built = plan().map((build, index) => build(index + 1, 1_000))
          rows.push(...built)
          return built
        }
      })
      const mutations = [
        item('saved', repeatedAs === 'oversized' ? 'x'.repeat(1_500_001) : 'first'),
        ...Array.from({ length: 200 }, (_, index) => item(`filler-${index}`)),
        repeatedAs === 'alias'
          ? { kind: 'tombstone' as const, itemId: 'alias' }
          : item('saved', 'second')
      ]
      expect(() =>
        appender.planResolved({ settlementId: 'settlement', fence: 8, resolve: () => mutations })
      ).toThrow('journal_resolved_lifecycle_batch_names_item_twice')
      expect(rows).toEqual([])
      expect(state.items.size).toBe(0)
      expect(state.lastSequence).toBe(0)
    }
  )
})
