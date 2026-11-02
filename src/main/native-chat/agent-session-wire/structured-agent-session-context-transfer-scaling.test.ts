import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecoveryExportRoot } from '../agent-session-context-recovery-exports'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { renderRecoveryItem, selectRecoveryDelivery } from '../agent-session-context-transfer-text'
import {
  closeContextTransfers,
  writeContextTransfer
} from '../agent-session-journal/context-transfer-repository'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
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
  expectSameKeyedWork,
  instrumentContextTransferFacts,
  seedClosedContextHistories
} from '../agent-session-journal/context-transfer-scaling.test-support'
import * as journalOpen from '../agent-session-journal/journal-open'
import { rebaseCompletedContextRewind } from '../agent-session-journal/context-transfer-rebase'
import { captureRecoveryContext } from '../agent-session-journal/context-transfer-capture'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { catchUpCodexThread } from '../../codex/codex-structured-thread-catch-up'
import { codexWith } from '../../codex/codex-thread-catch-up-contract-test-fixture'
import { persistRewindRecord } from './structured-rewind-recovery'
import { PiRpcSessionAdapter } from '../../pi/rpc-session-adapter'
import * as dispatchContent from '../../claude/structured/claude-structured-dispatch-content'

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

async function retainedHistoryWork(closed: number) {
  const { fixture, journal, native, db, retained } = await withClosedHistories(closed)
  const facts = instrumentContextTransferFacts(db)
  journal.contextTransfers.reopen()
  const reopen = { ...facts.counts }
  facts.reset()
  const send = await fixture.accept('One ordinary send after the historical handoffs closed')
  await eventually(async () =>
    expect((await fixture.submission(send))?.dispatchState).toBe('accepted')
  )
  const sent = { ...facts.counts }
  facts.reset()
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
  const marked = { ...facts.counts }
  const inserts = vi.spyOn(db, 'prepare')
  journal.contextTransfers.commit((tx) =>
    closeContextTransfers(tx, SESSION, 'clear-now', 'context-clear', 2)
  )
  const clearWrites = inserts.mock.calls.filter(([sql]) =>
    sql.startsWith('INSERT INTO agent_session_context_transfers')
  ).length
  expect(facts.unbounded()).toEqual([])
  return { reopen, sent, marked, clearWrites, retained }
}

it('keeps reopen, send, marked output and clear independent of retained closed histories', async () => {
  const small = await retainedHistoryWork(20)
  const large = await retainedHistoryWork(200)
  // Reopen reads every retained row once; after it nothing else does.
  expect(small.reopen).toMatchObject({ audits: 1, decodes: 0, transferQueries: 0 })
  expect(large.reopen.auditedRows - small.reopen.auditedRows).toBe(large.retained - small.retained)
  for (const phase of ['reopen', 'sent', 'marked'] as const) {
    expectSameKeyedWork(small[phase], large[phase])
  }
  for (const phase of ['sent', 'marked'] as const) {
    expect([small[phase].audits, large[phase].audits]).toEqual([0, 0])
  }
  expect({ small: small.clearWrites, large: large.clearWrites }).toEqual({ small: 1, large: 1 })
})

const refusal = () => ({
  state: 'rejected' as const,
  ...agentSessionFailureWords(agentSessionFailureFact('cancelled', { neverReachedAgent: true }), {
    surface: 'rejection'
  })
})

async function retainedAttemptsWork(retained: number) {
  const fixture = await contextTransferFixture()
  fixtures.push(fixture)
  const { journal } = await fixture.recoverSavedChat(async () => ({ kind: 'unsupported' }))
  fixture.dispatch.mockResolvedValueOnce(refusal())
  const first = await fixture.accept('Refused before it reached the agent')
  await eventually(async () =>
    expect((await fixture.submission(first))?.dispatchState).toBe('rejected')
  )
  const attempt = journal.contextTransfers
    .read()
    .find((row) => row.kind === 'delivery' && row.outcome?.kind === 'refused-before-write')
  if (attempt?.kind !== 'delivery') {
    throw new Error('Missing refused attempt')
  }
  const { writeStartedAt: _, ...unstarted } = attempt
  // Known refusals and attempts whose pending write failed both stay on the same owed target.
  journal.contextTransfers.commit((db) => {
    for (let i = 1; i < retained; i++) {
      writeContextTransfer(db, { ...attempt, id: `refused-${i}`, carrierInputId: `refused-${i}` })
      writeContextTransfer(db, {
        ...unstarted,
        id: `unstarted-${i}`,
        carrierInputId: `unstarted-${i}`,
        outcome: null
      })
    }
  })
  await fixture.restart()
  const facts = instrumentContextTransferFacts(openTestJournalHostDatabase(fixture.root).db)
  const send = async (text: string, refused: boolean) => {
    facts.reset()
    if (refused) {
      fixture.dispatch.mockResolvedValueOnce(refusal())
    }
    const id = await fixture.accept(text)
    await eventually(async () =>
      expect((await fixture.submission(id))?.dispatchState).toBe(refused ? 'rejected' : 'accepted')
    )
    return { ...facts.counts }
  }
  const opened = await send('First send after the restart', true)
  const retried = await send('Retry with the saved number', false)
  expect(JSON.stringify(fixture.dispatch.mock.calls.at(-1)![0].body)).toContain('42')
  expect(facts.unbounded()).toEqual([])
  return { opened, retried }
}

it('audits a chat once when it opens, then sends and retries with keyed work at 20 or 200 retained attempts', async () => {
  const small = await retainedAttemptsWork(20)
  const large = await retainedAttemptsWork(200)
  expect([small.opened.audits, large.opened.audits]).toEqual([1, 1])
  // Each retained attempt adds one refused and one unstarted row, read once by the audit.
  expect(large.opened.auditedRows - small.opened.auditedRows).toBe(2 * 180)
  expect([small.retried.audits, large.retried.audits]).toEqual([0, 0])
  expectSameKeyedWork(small.opened, large.opened)
  expectSameKeyedWork(small.retried, large.retried)
})

async function injectedReplayWork(items: number) {
  const { fixture, journal, native } = await settledRecovery()
  const records = journal.contextTransfers.read()
  const delivery = records.find((row) => row.kind === 'delivery' && row.mode === 'inject')
  const handoff = records.find((row) => row.kind === 'handoff')
  const message = handoff?.kind === 'handoff' ? handoff.capture.messages[0] : undefined
  if (delivery?.kind !== 'delivery' || !message) {
    throw new Error('Missing injected history')
  }
  const echo = renderRecoveryItem(delivery.id, message)
  const db = openTestJournalHostDatabase(fixture.root).db
  const facts = instrumentContextTransferFacts(db)
  await journal.appendLifecycleBatch({
    settlementId: `replay-${items}`,
    fence: fixture.store.requireWritableRecord(SESSION).lease.runtimeFence,
    mutations: Array.from({ length: items }, (_, ordinal) => ({
      kind: 'item' as const,
      identity: { provider: 'codex' as const, threadId: native(), turnId: 'replay', ordinal },
      body: { ...hostTestMessage(echo), role: message.role },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
  })
  expect(JSON.stringify(journal.snapshot())).not.toContain(echo)
  expect(facts.unbounded()).toEqual([])
  return { ...facts.counts }
}

it('decodes the injected history a replay echoes once per batch, at 10 or 100 echoed items', async () => {
  const small = await injectedReplayWork(10)
  const large = await injectedReplayWork(100)
  expect(small.decodes).toBeGreaterThan(0)
  expectSameKeyedWork(small, large)
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
    journal.contextTransfers.facts(),
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

it('publishes a recovery target with keyed reads whatever history is retained', async () => {
  const work = async (closed: number) => {
    const { facts, retained } = await reattachedRecovery(closed)
    expect(facts.unbounded()).toEqual([])
    return { retained, ...facts.counts }
  }
  const small = await work(20)
  const large = await work(200)
  expect(large.retained).toBe(small.retained + 720)
  expect([small.audits, large.audits]).toEqual([1, 1])
  expectSameKeyedWork(small, large)
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
    expect(facts.unbounded()).toEqual([])
    return { ...facts.counts, encodings: encode.mock.calls.length, usage: usage.mock.calls.length }
  }
  const small = await work(20)
  const large = await work(200)
  expectSameKeyedWork(small, large)
  expect({ encodings: large.encodings, usage: large.usage }).toEqual({
    encodings: small.encodings,
    usage: small.usage
  })
  expect(small.encodings).toBeGreaterThan(1)
})

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4096 - 8, 7)])

async function piCarrierWork(images: number, shrinks: number) {
  const { fixture, journal } = await reattachedRecovery(0)
  fixture.host.deps.adapter.injectHistoricalContext = undefined
  const pi = new PiRpcSessionAdapter({
    resolveLaunch: async () => {
      throw new Error('Pi is not launched here')
    },
    onLifecycle: () => {},
    onSettled: () => {},
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  const blocks: AgentJournalMessageItem['blocks'] = [{ type: 'text', text: 'Look at these' }]
  for (let i = 0; i < images; i++) {
    const path = join(fixture.root, `image-${i}.png`)
    await writeFile(path, PNG)
    blocks.push({ type: 'image-ref', path })
  }
  const reads = vi.spyOn(dispatchContent, 'readClaudeImage').mockClear()
  const encoded: number[] = []
  let pressure = shrinks
  fixture.host.deps.adapter.historicalInputBytes = async (input) => {
    const measured = await pi.historicalInputBytes(input)
    encoded.push(measured.bytes)
    // An escape-heavy history can encode past the limit; each report forces one shrink.
    const carried = input.body.blocks.some(
      (block) => block.type === 'text' && block.text.includes('<orca_context_handoff')
    )
    return carried && pressure-- > 0 ? { ...measured, bytes: measured.limit + 1 } : measured
  }
  const body = { ...hostTestMessage(''), blocks }
  const sent = await fixture.accept(body)
  await eventually(async () =>
    expect((await fixture.submission(sent))?.dispatchState).toBe('accepted')
  )
  const carrier = fixture.dispatch.mock.calls.at(-1)![0].body
  expect(JSON.stringify(carrier)).toContain('42')
  expect(carrier.blocks.filter((block) => block.type === 'image-ref')).toEqual(
    blocks.filter((block) => block.type === 'image-ref')
  )
  expect(journal.itemBody(agentJournalSubmissionKey(sent))).toEqual(body)
  return { reads: reads.mock.calls.length, measures: encoded.length, carrierBytes: encoded[0]! }
}

it('reads and encodes the images of a Pi carrier once, however often its history shrinks', async () => {
  const small = await piCarrierWork(1, 1)
  const shrunk = await piCarrierWork(1, 4)
  const large = await piCarrierWork(10, 1)
  expect(small.reads).toBe(1)
  expect(shrunk.reads).toBe(1)
  expect(large.reads).toBe(10)
  // Two fixed measures, then one text-only measure per selection.
  expect(small.measures).toBe(2 + 2)
  expect(shrunk.measures).toBe(2 + 5)
  expect(large.measures).toBe(small.measures)
  const image = Buffer.byteLength(
    JSON.stringify({
      type: 'image',
      data: PNG.toString('base64'),
      mimeType: 'image/png'
    })
  )
  expect(large.carrierBytes - small.carrierBytes).toBe(9 * (image + 1))
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
    expect(facts.unbounded()).toEqual([])
    return { ...facts.counts, echoes: echo.mock.calls.length }
  }
  const small = await work(20)
  const large = await work(200)
  expect(small.echoes).toBeGreaterThanOrEqual(10)
  expect(large.echoes).toBe(small.echoes)
  expectSameKeyedWork(small, large)
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
  expectSameKeyedWork(small.rewound, large.rewound)
  expect({ small: small.repeated.restores, large: large.repeated.restores }).toEqual({
    small: 0,
    large: 0
  })
  expectSameKeyedWork(small.repeated, large.repeated)
})

it('authenticates an export with no retained-history work and source reads linear in the source', async () => {
  const work = async (closed: number, items: number) => {
    const { fixture, journal, db } = await withClosedHistories(closed)
    // Recovery's own export may hold this key's slot; the contract measures work, not slot choice.
    await rm(agentSessionRecoveryExportRoot(fixture.root), { recursive: true, force: true })
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
    expect(facts.unbounded()).toEqual([])
    return { ...facts.counts, sourceReads: view.reads.count }
  }
  const small = await work(20, 20)
  const retained = await work(200, 20)
  const source = await work(20, 200)
  expect(small).toMatchObject({ decodes: 0, transferQueries: 0 })
  expectSameKeyedWork(small, retained)
  expect(retained.sourceReads).toBe(small.sourceReads)
  // Authentication must re-read the whole source, so this alone grows with it.
  expect(source.sourceReads).toBe(small.sourceReads * 10)
})

it('leaves no fact behind a rolled-back write', async () => {
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
  expect(deriveContextTransferState(journal.contextTransfers.facts(), chain()).kind).toBe('settled')
})
