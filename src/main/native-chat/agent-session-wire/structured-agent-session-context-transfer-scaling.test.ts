import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
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
  transferEventually as eventually
} from './structured-agent-session-context-transfer.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { prepareNativeRecovery } from './structured-agent-session-recovery'

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
  return { fixture, journal: recovery.journal, native: recovery.native }
}

/** Closed histories stay retained after clear; seed them around the live recovery's facts. */
async function withClosedHistories(closed: number) {
  const { fixture, journal, native } = await settledRecovery()
  const live = journal.contextTransfers.read()
  const handoff = live.find((row) => row.kind === 'handoff')
  const target = live.find((row) => row.kind === 'target')
  const delivery = live.find((row) => row.kind === 'delivery')
  if (handoff?.kind !== 'handoff' || target?.kind !== 'target' || delivery?.kind !== 'delivery') {
    throw new Error('Missing settled recovery facts')
  }
  if (!target.targetLink) {
    throw new Error('Missing published target')
  }
  const old: ContextTransferRecord[] = []
  for (let i = 0; i < closed; i++) {
    const handoffId = `old-H-${i}`
    const targetId = `old-T-${i}`
    old.push(
      { ...handoff, id: handoffId, handoffId },
      {
        ...target,
        id: targetId,
        handoffId,
        firstInputId: `old-P-${i}`,
        targetLink: {
          ...target.targetLink,
          linkId: `old-L-${i}`,
          handle: {
            ...target.targetLink.handle,
            nativeId: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`
          }
        }
      },
      { ...delivery, id: `old-D-${i}`, handoffId, targetId },
      {
        kind: 'closure',
        id: `old-C-${i}`,
        sessionId: SESSION,
        handoffId,
        commandId: `clear-${i}`,
        at: 1,
        cause: 'context-clear'
      }
    )
  }
  const db = openTestJournalHostDatabase(fixture.root).db
  db.prepare('DELETE FROM agent_session_context_transfers WHERE session_id = ?').run(SESSION)
  const insert = db.prepare(
    'INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json) VALUES (?,?,?,?,1,?)'
  )
  for (const record of [...old, ...live]) {
    insert.run(record.id, SESSION, record.handoffId, record.kind, JSON.stringify(record))
  }
  return { fixture, journal, native, db }
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
