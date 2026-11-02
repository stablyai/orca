import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { selectRecoveryDelivery } from '../agent-session-context-transfer-text'
import {
  contextTransferRecordSchema,
  type ContextTransferRecord
} from '../agent-session-journal/context-transfer-record'
import { closeContextTransfers } from '../agent-session-journal/context-transfer-repository'
import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  contextTransferFixture,
  transferEventually as eventually,
  TRANSFER_CALLER
} from './structured-agent-session-context-transfer.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { prepareNativeRecovery } from './structured-agent-session-recovery'
import {
  instrumentContextTransferFacts,
  seedClosedContextHistories
} from '../agent-session-journal/context-transfer-scaling.test-support'
import * as journalOpen from '../agent-session-journal/journal-open'
import { rebaseCompletedContextRewind } from '../agent-session-journal/context-transfer-rebase'
import { captureRecoveryContext } from '../agent-session-journal/context-transfer-capture'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { catchUpCodexThread } from '../../codex/codex-structured-thread-catch-up'
import { codexWith } from '../../codex/codex-thread-catch-up-contract-test-fixture'
import { persistRewindRecord } from './structured-rewind-recovery'

// N/10N contracts: count record visits, decodes, writes and text reads, never time.
const fixtures: Awaited<ReturnType<typeof contextTransferFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

async function settledRecovery() {
  const fixture = await contextTransferFixture()
  fixtures.push(fixture)
  const recovery = await fixture.recoverSavedChat(async () => ({
    kind: 'injected',
    requestId: 'ack'
  }))
  const settle = await fixture.accept('Settle the prepared handoff')
  await eventually(async () =>
    expect((await fixture.submission(settle))?.dispatchState).toBe('accepted')
  )
  return { fixture, journal: recovery.journal, native: recovery.native, lose: recovery.lose }
}

async function withClosedHistories(closed: number) {
  const { fixture, journal, native, lose } = await settledRecovery()
  const db = openTestJournalHostDatabase(fixture.root).db
  const retained = seedClosedContextHistories(db, SESSION, journal.contextTransfers.read(), closed)
  return { fixture, journal, native, lose, db, retained }
}

function countKindReads(records: readonly ContextTransferRecord[]) {
  const reads = { count: 0 }
  for (const record of records) {
    const kind = record.kind
    Object.defineProperty(record, 'kind', {
      enumerable: true,
      get: () => {
        reads.count += 1
        return kind
      }
    })
  }
  return reads
}

async function retainedHistoryWork(closed: number) {
  const { fixture, journal, native, db } = await withClosedHistories(closed)
  const decode = vi.spyOn(contextTransferRecordSchema, 'safeParse')
  journal.contextTransfers.reopen()
  const reopenDecodes = decode.mock.calls.length
  const chain = () => fixture.store.requireWritableRecord(SESSION).providerHandleChain
  // Reopen rederives once; later work must reuse that derivation.
  deriveContextTransferState(journal.contextTransfers.read(), chain())
  const reads = countKindReads(journal.contextTransfers.read())
  decode.mockClear()
  const send = await fixture.accept('One ordinary send after the historical handoffs closed')
  await eventually(async () =>
    expect((await fixture.submission(send))?.dispatchState).toBe('accepted')
  )
  const sendDecodes = decode.mock.calls.length
  const sendReads = reads.count
  const marked = countKindReads(journal.contextTransfers.read())
  await journal.appendItem(
    { provider: 'codex', threadId: native(), turnId: 'marked-output', ordinal: 0 },
    {
      ...hostTestMessage('<orca_context_handoff id="old-D-0">\nQuoted\n</orca_context_handoff>'),
      role: 'assistant'
    },
    {
      fence: fixture.store.requireWritableRecord(SESSION).lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  const markedReads = marked.count
  const inserts = vi.spyOn(db, 'prepare')
  journal.contextTransfers.commit((tx) =>
    closeContextTransfers(tx, SESSION, 'clear-now', 'context-clear', 2)
  )
  const clearWrites = inserts.mock.calls.filter(([sql]) =>
    sql.startsWith('INSERT INTO agent_session_context_transfers')
  ).length
  decode.mockRestore()
  return { reopenDecodes, sendDecodes, sendReads, markedReads, clearWrites }
}

it('keeps send, marked output and clear independent of retained closed histories', async () => {
  const small = await retainedHistoryWork(20)
  const large = await retainedHistoryWork(200)
  // Reopen decodes each retained record once (3 live + 4 per closed history).
  expect(small.reopenDecodes).toBe(83)
  expect(large.reopenDecodes).toBe(803)
  expect(large).toMatchObject({
    sendDecodes: 0,
    sendReads: small.sendReads,
    markedReads: small.markedReads,
    clearWrites: 1
  })
  expect(small).toMatchObject({ sendDecodes: 0, clearWrites: 1 })
})

function savedView(base: AgentJournalSnapshot, items: number, text: string) {
  const reads = { count: 0 }
  const message = base.items.find((item) => item.body.kind === 'message')
  if (!message) {
    throw new Error('Missing saved message')
  }
  const snapshot: AgentJournalSnapshot = {
    ...base,
    submissions: [],
    items: Array.from({ length: items }, (_, i) => ({
      ...message,
      itemId: `saved-${i}`,
      sequence: i + 1,
      body: {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [
          {
            type: 'text' as const,
            get text() {
              reads.count += 1
              return text
            }
          }
        ]
      }
    }))
  }
  return { snapshot, reads }
}

async function recoveryWork(items: number) {
  const { fixture, journal } = await settledRecovery()
  const record = fixture.store.requireWritableRecord(SESSION)
  const source = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!source) {
    throw new Error('Missing recovered head')
  }
  const view = savedView(journal.snapshot(), items, 'x'.repeat(4_000))
  vi.spyOn(journal, 'snapshot').mockReturnValue(view.snapshot)
  const prepare = () =>
    prepareNativeRecovery({
      store: fixture.store,
      journal,
      record,
      source,
      trigger: 'uncertain-context-delivery',
      now: 2
    })
  prepare()
  const captureReads = view.reads.count
  view.reads.count = 0
  prepare()
  const reentryReads = view.reads.count
  const state = deriveContextTransferState(
    journal.contextTransfers.read(),
    record.providerHandleChain
  )
  if (state.kind === 'none') {
    throw new Error('Missing frozen successor')
  }
  const frozen = state.handoff.capture.messages
  let selectionReads = 0
  const counted = frozen.map((message) => ({
    ...message,
    get text() {
      selectionReads += 1
      return message.text
    }
  }))
  selectRecoveryDelivery({
    id: 'carrier',
    capture: { ...state.handoff.capture, messages: counted },
    body: hostTestMessage('Next input')
  })
  return {
    captureReads,
    reentryReads,
    frozenBytes: Buffer.byteLength(JSON.stringify(state.handoff.capture)),
    selectionReads
  }
}

it('captures once per new source, linearly, and bounds carrier selection by the frozen cap', async () => {
  const small = await recoveryWork(20)
  const large = await recoveryWork(200)
  expect(small.reentryReads).toBe(0)
  expect(large.reentryReads).toBe(0)
  expect(large.captureReads).toBeLessThanOrEqual(small.captureReads * 10)
  expect(large.frozenBytes).toBeLessThanOrEqual(64_000)
  expect(large.selectionReads).toBe(small.selectionReads)
})

const markedTurn = (index: number) => ({
  id: `marked-turn-${index}`,
  status: 'completed',
  itemsView: 'full',
  startedAt: 1_700_000_000 + index * 100,
  completedAt: 1_700_000_000 + index * 100 + 50,
  items: [
    {
      type: 'userMessage',
      id: `marked-u-${index}`,
      content: [{ type: 'text', text: `ask ${index}` }]
    },
    {
      type: 'agentMessage',
      id: `marked-a-${index}`,
      text: `<orca_context_handoff id="old-D-${index}">\nQuoted\n</orca_context_handoff>`
    }
  ]
})

async function reattachedRecovery(closed: number) {
  const setup = await withClosedHistories(closed)
  const { fixture, lose, db } = setup
  await fixture.host.close(SESSION, 'evict')
  lose()
  const facts = instrumentContextTransferFacts(db)
  expect(
    await fixture.host.attach(
      TRANSFER_CALLER,
      hostTestAttachParams(fixture.store.requireWritableRecord(SESSION).lease.runtimeFence)
    )
  ).toMatchObject({ ok: true })
  await eventually(() => expect(fixture.childPhase()).toBe('ready'))
  const journal = fixture.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  return { ...setup, journal, facts }
}

it('publishes a recovery target with one fact load whatever history is retained', async () => {
  const work = async (closed: number) => {
    const { facts, retained } = await reattachedRecovery(closed)
    return { retained, ...facts.counts }
  }
  const small = await work(20)
  const large = await work(200)
  // Reopening loads each retained record once; publication itself adds no load or scan.
  for (const counts of [small, large]) {
    expect(counts).toMatchObject({ decodes: counts.retained, loads: 1, transferSelects: 1 })
  }
  expect(large.kindReads).toBe(small.kindReads)
})

it('carries owed history through occupancy, encoding and selection independent of retained history', async () => {
  const work = async (closed: number) => {
    const { fixture, journal, facts } = await reattachedRecovery(closed)
    const encode = vi.fn(async (input: { body: AgentJournalMessageItem }) => ({
      bytes: Buffer.byteLength(JSON.stringify(input.body)),
      limit: 1024 * 1024
    }))
    fixture.host.deps.adapter.historicalInputBytes = encode
    const usage = vi.spyOn(journal, 'contextUsage')
    facts.reset()
    const sent = await fixture.accept('Carry the saved number')
    await eventually(async () =>
      expect((await fixture.submission(sent))?.dispatchState).toBe('accepted')
    )
    return { ...facts.counts, encodings: encode.mock.calls.length, usage: usage.mock.calls.length }
  }
  const small = await work(20)
  const large = await work(200)
  expect(small).toMatchObject({ decodes: 0, loads: 0, transferSelects: 0 })
  expect(large).toEqual(small)
  expect(small.encodings).toBeGreaterThan(1)
})

it('classifies marked Codex history imports without scanning retained history', async () => {
  const work = async (closed: number) => {
    const { fixture, journal, native, db } = await withClosedHistories(closed)
    const facts = instrumentContextTransferFacts(db)
    journal.contextTransfers.reopen()
    facts.reset()
    const echo = vi.spyOn(journal, 'recoveryEcho')
    await catchUpCodexThread({
      connection: codexWith(Array.from({ length: 10 }, (_, index) => markedTurn(index))),
      threadId: native(),
      sessionId: SESSION,
      sink: fixture.acquire.mock.calls.at(-1)![0].events!
    })
    return { ...facts.counts, echoes: echo.mock.calls.length }
  }
  const small = await work(20)
  const large = await work(200)
  expect(small.echoes).toBeGreaterThanOrEqual(10)
  expect(small).toMatchObject({ decodes: 0, loads: 0 })
  expect(large).toEqual(small)
})

it('rebases a rewind once, without restoring the journal again for a repeated publication', async () => {
  const work = async (closed: number) => {
    const { fixture, journal, db } = await withClosedHistories(closed)
    const facts = instrumentContextTransferFacts(db)
    journal.contextTransfers.reopen()
    const kept = journal.snapshot().items.flatMap((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      return identity
        ? [
            {
              identity,
              body: item.body,
              observedAt: item.observedAt,
              ownerFence: journal.itemFence(item.itemId) ?? 1,
              turnScope: item.turnScope
            }
          ]
        : []
    })
    const rewind = {
      operationId: 'scaled-rewind',
      callerKey: TRANSFER_CALLER.callerKey,
      itemId: journal.snapshot().items[0]!.itemId,
      expectedEpoch: journal.cursor().epoch,
      phase: 'provider-succeeded' as const
    }
    const fence = fixture.store.requireWritableRecord(SESSION).lease.runtimeFence
    await persistRewindRecord(fixture.store, SESSION, fence, rewind)
    facts.reset()
    await journal.replaceEpochItems('handle_forked', fence, kept, (cursor) =>
      fixture.store.conversationReceipts.rewind(SESSION, fence, rewind, cursor)
    )
    const rewound = { ...facts.counts }
    const restore = vi.spyOn(journalOpen, 'restoreJournal')
    facts.reset()
    journal.contextTransfers.commit((tx) => rebaseCompletedContextRewind(tx, SESSION))
    const repeated = { ...facts.counts, restores: restore.mock.calls.length }
    restore.mockRestore()
    return { rewound, repeated }
  }
  const small = await work(20)
  const large = await work(200)
  expect(small.rewound).toMatchObject({ decodes: 0, loads: 0, transferSelects: 0 })
  expect(large.rewound).toEqual(small.rewound)
  expect(small.repeated).toEqual({
    decodes: 0,
    loads: 0,
    kindReads: 0,
    transferSelects: 0,
    restores: 0
  })
  expect(large.repeated).toEqual(small.repeated)
})

it('authenticates an export with no retained-history work and source reads linear in the source', async () => {
  const work = async (closed: number, items: number) => {
    const { journal, db } = await withClosedHistories(closed)
    const facts = instrumentContextTransferFacts(db)
    journal.contextTransfers.reopen()
    const base = journal.snapshot()
    const view = savedView(base, items, 'saved export text')
    const snapshot = { ...view.snapshot, cursor: { ...base.cursor, sequence: items + 1 } }
    vi.spyOn(journal, 'snapshot').mockReturnValue(snapshot)
    const live = journal.contextTransfers.read().find((row) => row.kind === 'handoff')
    if (live?.kind !== 'handoff') {
      throw new Error('Missing frozen source')
    }
    const handoff = {
      ...live,
      id: `export-${closed}-${items}`,
      handoffId: `export-${closed}-${items}`,
      sourceCursor: snapshot.cursor,
      capture: captureRecoveryContext(snapshot, journal.canonicalItemId).capture
    }
    view.reads.count = 0
    facts.reset()
    const path = await journal.exportRecoveryContext(handoff)
    expect(path).toEqual(expect.any(String))
    return { ...facts.counts, sourceReads: view.reads.count }
  }
  const small = await work(20, 20)
  const retained = await work(200, 20)
  const source = await work(20, 200)
  expect(small).toMatchObject({ decodes: 0, loads: 0, kindReads: 0, transferSelects: 0 })
  expect(retained).toEqual(small)
  // Authentication must re-read the whole source, so this alone grows with it.
  expect(source.sourceReads).toBe(small.sourceReads * 10)
})

it('leaves no cached fact behind a rolled-back write', async () => {
  const { fixture, journal } = await settledRecovery()
  const chain = () => fixture.store.requireWritableRecord(SESSION).providerHandleChain
  const before = [...journal.contextTransfers.read()]
  expect(() =>
    journal.contextTransfers.commit((db) => {
      closeContextTransfers(db, SESSION, 'rolled-back-clear', 'context-clear', 3)
      throw new Error('clear failed after closing')
    })
  ).toThrow('clear failed after closing')
  expect(journal.contextTransfers.read()).toEqual(before)
  expect(deriveContextTransferState(journal.contextTransfers.read(), chain()).kind).toBe('settled')
})
