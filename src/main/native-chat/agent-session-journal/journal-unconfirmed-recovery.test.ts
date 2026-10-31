import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import * as records from '../../../shared/agent-session-record.test-fixture'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { nextSendableQueuedCard } from './queued-message-pause'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionStoppedHistoryOwed } from '../../../shared/agent-session-stopped-history'
import { structuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { recordStructuredAgentSessionStartFailure } from '../agent-session-wire/structured-agent-session-start-failure-row'
import { settleObservedExitForTest } from '../agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  appendTestJournalQueueRow,
  openTestJournalHostDatabase,
  createTrackedJournalOpener
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
const identity = {
  sessionId: 'recovery-flow',
  workspaceId: 'ws',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
let root: string
let journal: AgentSessionJournal
let held: Set<string>
let lease: ReturnType<typeof records.agentSessionLeaseFixture>
let clock = 1000
const conversation = () => agentSessionConversationView(records.agentSessionRecordFixture(lease))
const work = () =>
  structuredAgentSessionCurrentWork(journal, {
    record: conversation(),
    child: { fence: 7, heldSends: () => held }
  })
const open = async () => {
  journal = await journals.open({ identity, stateDirectory: root, now: () => ++clock })
  journal.queuedMessages.inputWork = work
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'b1-recovery-'))
  held = new Set()
  lease = records.agentSessionLeaseFixture({ sessionId: identity.sessionId })
  await open()
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
const cardId = (id: string) => `recovery:${id}`
async function send(id: string, handed = true, message = body(id)) {
  await journal.appendSubmission({
    clientMessageId: id,
    body: message,
    payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, message),
    fence: 7,
    origin: 'client',
    source: { kind: 'user' },
    handoverRecorded: true
  })
  if (handed) {
    await journal.resolveDispatch({
      clientMessageId: id,
      state: 'pending',
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
}
async function ended(id = 'turn') {
  await journal.appendItem(
    { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: `turn-lifecycle:${id}` },
    { kind: 'turn', turnId: id, state: 'completed' },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}
async function receipt(id: string) {
  await journal.resolveDispatch({
    clientMessageId: id,
    state: 'accepted',
    fence: 7,
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'receipt', ordinal: clock }
  })
}

function savedCopy(id: string, changedBody?: AgentJournalMessageItem) {
  appendTestJournalQueueRow(openTestJournalHostDatabase(root).db, journal, cardId(id), {
    op: 'queued',
    body: changedBody ?? journal.submissionBody(id)!,
    position: 0,
    queuedAt: journal.cursor(),
    recovers: id,
    options: { model: 'gpt-5', effort: 'high' },
    ...(!changedBody
      ? {
          returned: {
            reason: 'old uncertainty sentence',
            rejection: { kind: 'unconfirmed' as const }
          }
        }
      : {})
  })
  return journal.queuedMessages.get(cardId(id))!
}

it('keeps uncertain input ordinary, rejects stale virtual actions, and preserves exclusive stopped carry', async () => {
  await send('send')
  await ended()
  const original = journal.submission('send')!
  expect(journal.itemBody(agentJournalSubmissionKey('send'))).toEqual(body('send'))
  expect(journal.queuedMessages.list()).toEqual([])
  expect(
    await journal.queuedMessages.update({
      messageId: cardId('send'),
      expectedBodyFingerprint: original.payloadFingerprint,
      text: 'typing'
    })
  ).toMatchObject({ status: 'gone' })
  await expect(
    journal.appendSubmission(
      {
        clientMessageId: 'phantom',
        body: body('send'),
        payloadFingerprint: original.payloadFingerprint,
        fence: 7,
        origin: 'client',
        handoverRecorded: true
      },
      { messageId: cardId('send'), expect: 'returned' }
    )
  ).rejects.toThrow()
  expect(journal.submission('phantom')).toBeUndefined()
  expect(journal.submission('send')).toEqual(original)
  await journal.close()
  await open()
  expect(journal.itemBody(agentJournalSubmissionKey('send'))).toEqual(body('send'))
  expect(journal.queuedMessages.list()).toEqual([])
  await send('stopped', false)
  await journal.stops.accept({ event: { reason: 'user-stop' }, fence: 7, liveTurnId: () => null })
  const carried = agentSessionStoppedHistoryOwed({
    submissions: journal.submissions(),
    carried: journal.stoppedHistoryCarried(),
    clearSequence: 0,
    body: (id) => journal.itemBody(agentJournalSubmissionKey(id))
  })
  expect(carried.map((entry) => entry.clientMessageId)).toContain('stopped')
  expect(journal.queuedMessages.get(cardId('stopped'))).toBeNull()
  await journal.replaceEpochItems('handle_forked', 7, [])
  await send('carrier', false)
  const { carriedStoppedHistory } =
    await import('../agent-session-wire/structured-agent-session-stopped-history-selection')
  expect(
    carriedStoppedHistory(
      { journal },
      AGENT_JOURNAL_THREAD_SCOPE,
      journal.submission('carrier')!,
      body('carrier')
    )?.covers
  ).toContain('stopped')
  await journal.resolveDispatch({
    clientMessageId: 'carrier',
    state: 'pending',
    fence: 7,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    carries: ['stopped']
  })
  await ended('carrier-end')
  expect(journal.queuedMessages.get(cardId('carrier'))).toBeNull()
  expect(journal.submissionBody('carrier')).toEqual(body('carrier'))
  expect(
    agentSessionStoppedHistoryOwed({
      submissions: journal.submissions(),
      carried: journal.stoppedHistoryCarried(),
      clearSequence: 0,
      body: (id) => journal.itemBody(agentJournalSubmissionKey(id))
    })
  ).toEqual([])
  await send('boundary')
  held.add('boundary')
  await ended('boundary-end')
  expect(journal.queuedMessages.get(cardId('boundary'))).toBeNull()
  await receipt('boundary')
  held.delete('boundary')
  expect(journal.queuedMessages.get(cardId('boundary'))).toBeNull()
  // An existing provider-item echo also settles a carrier, without a separate dispatch row.
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread', turnId: 'implicit', ordinal: 0 },
    body('carrier'),
    { fence: 7, turnScope: { kind: 'thread' } }
  )
  expect(journal.submission('carrier')?.dispatchState).toBe('accepted')
  await journal.replaceEpochItems('handle_forked', 7, [])
  await journal.close()
  await open()
  expect(journal.submission('carrier')?.dispatchState).toBe('accepted')
  expect(journal.stoppedHistoryCarried().get('carrier')).toEqual(['stopped'])
  expect(journal.queuedMessages.get(cardId('carrier'))).toBeNull()
})

it('retains ordinary input through restart/reconciliation and exact replay receipt', async () => {
  await send('restart')
  await ended('replayed')
  await journal.close()
  await open()
  await journal.markPendingSubmissionsUnknown(7)
  lease.unreconciled = true
  journal.queuedMessages.inputWork = () =>
    structuredAgentSessionCurrentWork(journal, {
      record: conversation(),
      child: null
    })
  expect(journal.queuedMessages.get(cardId('restart'))).toBeNull()
  lease.unreconciled = false
  lease.claimStatus = 'released'
  expect(journal.queuedMessages.get(cardId('restart'))).toBeNull()
  expect(journal.submissionBody('restart')).toEqual(body('restart'))
  const { catchUpCodexThread } = await import('../../codex/codex-structured-thread-catch-up')
  const { createDeferredStructuredAgentSessionEventSink } =
    await import('../agent-session-wire/structured-agent-session-event-sink')
  const { testEventSinkLogging } =
    await import('../agent-session-wire/structured-agent-session-logger-test-support')
  const sink = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  sink.bind({ journal, fence: 7, publish: () => {} })
  await catchUpCodexThread({
    sessionId: identity.sessionId,
    threadId: 'thread',
    sink: sink.sink,
    connection: {
      request: async () => ({
        data: [
          {
            id: 'replayed',
            status: 'completed',
            itemsView: 'full',
            items: [
              {
                type: 'userMessage',
                id: 'receipt',
                clientId: 'restart',
                content: [{ type: 'text', text: 'provider rendering' }]
              }
            ]
          }
        ],
        nextCursor: null
      })
    },
    onReceipt: (clientMessageId, providerIdentity) =>
      journal
        .acceptLate({
          clientMessageId,
          providerIdentity,
          state: 'accepted',
          fence: 7
        })
        .then(() => {})
  })
  sink.close()
  expect(journal.submission('restart')?.dispatchState).toBe('accepted')
  expect(journal.queuedMessages.get(cardId('restart'))).toBeNull()
})

it('shows the stopped queue again when a post-Stop direct send is no longer held', async () => {
  await journal.queuedMessages.insert({ messageId: 'waiting', body: body('waiting') })
  await journal.appendStopEvent({ reason: 'user-stop' }, 7)
  await send('post-stop')
  held.add('post-stop')
  const publish = () =>
    readQueuePublication(journal, () => ({
      record: records.agentSessionRecordFixture(lease),
      work: work()
    }))
  expect(publish().queuePause).toBeNull()
  held.delete('post-stop')
  expect(publish().queuePause).toEqual({ reason: 'stopped' })
})

it('keeps an image as a returned card on both failed-start routes in the rejection transaction', async () => {
  const image: AgentJournalMessageItem = {
    ...body('image'),
    blocks: [
      { type: 'text', text: 'image' },
      { type: 'image-ref', path: '/b1-image.png' }
    ]
  }
  const failure = agentSessionFailureWords(agentSessionFailureFact('startFailed'), {
    surface: 'rejection'
  })
  await send('queued-start', false, image)
  await recordStructuredAgentSessionStartFailure(
    { journal, fence: 7 },
    { ...failure, startKey: 'start' },
    'queued-start'
  )
  expect(journal.queuedMessages.get('queued-start')).toMatchObject({
    state: 'returned',
    body: image
  })
  await send('handed-start', true, image)
  await settleObservedExitForTest({
    journal,
    sessionId: identity.sessionId,
    fence: 7,
    settlementId: 'failed-child',
    verdict: { state: 'interrupted', completedAt: clock },
    pendingSubmissionReason: 'exited',
    exitedDuringStartup: { generation: 'child' },
    showUnexpectedExitOutcome: true
  })
  expect(journal.queuedMessages.get('handed-start')).toMatchObject({
    state: 'returned',
    body: image
  })
  await journal.close()
  await open()
  expect(journal.queuedMessages.get('handed-start')).toMatchObject({
    state: 'returned',
    body: image
  })
})

it('confirms id-less live receipts and releases unopened error/interrupt holds without deciding delivery', async () => {
  const { createCodexDispatchEchoes } = await import('../../codex/codex-structured-dispatch-echo')
  const { settleCodexSendsInEndedTurn } =
    await import('../../codex/codex-structured-turn-end-settlement')
  const remembered: string[] = []
  const echoes = createCodexDispatchEchoes(undefined, (id) => {
    remembered.push(id)
  })
  journal.queuedMessages.inputWork = () =>
    structuredAgentSessionCurrentWork(journal, {
      record: conversation(),
      child: { fence: 7, heldSends: echoes.heldSends }
    })
  const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'opened', ordinal: 1 }
  echoes.arm('late-opener')
  echoes.expect('late-opener', 'thread', 'start', [{ type: 'text', text: 'late' }])
  const earlyReceipt = { ...identity, turnId: 'late-turn', ordinal: 0 }
  expect(echoes.receipt(earlyReceipt, [{ type: 'text', text: 'late' }])).toBeNull()
  echoes.endTurn('thread', 'late-turn', { status: 'completed' })
  echoes.bindTurn('late-opener', 'thread', 'late-turn', 'start')
  expect(remembered).toEqual(['late-opener'])
  expect(echoes.receipt(earlyReceipt, [{ type: 'text', text: 'late' }])).toBe('late-opener')
  await send('legacy-error')
  echoes.arm('legacy-error')
  echoes.bindTurn('legacy-error', 'thread', 'unopened', 'start')
  settleCodexSendsInEndedTurn(
    { threadId: 'thread', dispatchEchoes: echoes },
    {
      sessionId: identity.threadId,
      method: 'error',
      params: {
        threadId: 'thread',
        turnId: 'unopened',
        willRetry: false,
        error: { message: 'failed' }
      }
    }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'error-row' },
    {
      kind: 'status',
      text: 'failed',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:error',
        payload: { head: '{}', byteLength: 2, digest: '', truncated: false }
      }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  expect(journal.queuedMessages.get(cardId('legacy-error'))).toBeNull()
  expect(journal.queuedMessages.attemptEnded('legacy-error')).toBe(true)
  expect(
    journal.submissions().find((send) => send.clientMessageId === 'legacy-error')?.dispatchState
  ).toBe('pending')
  await send('unopened-stop')
  echoes.arm('unopened-stop')
  echoes.bindTurn('unopened-stop', 'thread', 'stop-turn', 'start')
  await journal.appendStopEvent({ reason: 'user-stop' }, 7)
  expect(journal.queuedMessages.get(cardId('unopened-stop'))).toBeNull()
  echoes.endTurn('thread', 'stop-turn', { status: 'interrupted' })
  expect(journal.queuedMessages.get(cardId('unopened-stop'))).toBeNull()
  expect(journal.queuedMessages.attemptEnded('unopened-stop')).toBe(true)
})

it('retains full source, action resolution and exact late proof across cuts and epochs', async () => {
  const noop = { write: () => {}, committed: () => {} }
  await journal.context.clear(
    { operationId: 'clear-before-U', afterFence: 7, clearedAt: clock },
    noop
  )
  const floor = journal.context.floor()!
  const full: AgentJournalMessageItem = {
    ...body('original'),
    blocks: [
      { type: 'text', text: 'original' },
      { type: 'image-ref', path: '/image.png' }
    ]
  }
  await send('U', true, full)
  await ended('U-end')
  const original = savedCopy('U')
  await journal.context.rewind(floor, 7, [], () => noop)
  expect(journal.item(agentJournalSubmissionKey('U'))).toBeNull()
  expect(journal.queuedMessages.get(original.messageId)?.body).toEqual(full)
  await journal.replaceEpochItems('handle_forked', 7, [])
  expect(journal.item(agentJournalSubmissionKey('U'))).toBeNull()
  expect(journal.queuedMessages.get(original.messageId)?.body).toEqual(full)
  expect(journal.submission('U')?.handedOverAt).toBeDefined()
  await journal.rollEpoch('handle_forked', 7)
  await journal.close()
  await open()
  expect(journal.queuedMessages.get(original.messageId)?.body).toEqual(full)
  await receipt('U')
  expect(journal.queuedMessages.get(original.messageId)).toMatchObject({
    state: 'waiting',
    holdReason: 'delivery_unconfirmed',
    body: full
  })
  await send('delete-U')
  await ended('delete-end')
  savedCopy('delete-U')
  await journal.queuedMessages.withdraw([cardId('delete-U')])
  await journal.replaceEpochItems('handle_forked', 7, [])
  await journal.close()
  await open()
  expect(journal.queuedMessages.get(cardId('delete-U'))?.state).toBe('withdrawn')
  expect(journal.queuedMessages.list().filter((c) => c.state === 'returned')).toEqual([])
  await send('edited', true, full)
  await ended('edited-end')
  const edit = savedCopy('edited', full)
  const before = journal.cursor()
  await journal.queuedMessages.update({
    messageId: edit.messageId,
    expectedBodyFingerprint: edit.fingerprint,
    text: 'original'
  })
  expect(journal.cursor()).toEqual(before)
  await journal.queuedMessages.update({
    messageId: edit.messageId,
    expectedBodyFingerprint: edit.fingerprint,
    text: 'changed'
  })
  const changed = journal.queuedMessages.get(edit.messageId)!
  expect(changed).toMatchObject({
    state: 'waiting',
    holdReason: null,
    recovers: 'edited',
    options: edit.options
  })
  await journal.queuedMessages.update({
    messageId: edit.messageId,
    expectedBodyFingerprint: changed.fingerprint,
    text: 'original'
  })
  expect(journal.queuedMessages.get(edit.messageId)).toMatchObject({
    state: 'waiting',
    holdReason: null,
    body: full,
    options: edit.options
  })
  await journal.queuedMessages.update({
    messageId: edit.messageId,
    expectedBodyFingerprint: edit.fingerprint,
    text: 'changed'
  })
  await send('resent', true, full)
  await ended('resent-end')
  const retry = savedCopy('resent')
  await journal.appendSubmission(
    {
      clientMessageId: 'fresh-attempt',
      body: full,
      payloadFingerprint: retry.fingerprint,
      fence: 7,
      handoverRecorded: true
    },
    { messageId: retry.messageId, expect: 'waiting' }
  )
  await receipt('fresh-attempt')
  await journal.replaceEpochItems('handle_forked', 7, [])
  await journal.close()
  await open()
  await receipt('edited')
  await receipt('resent')
  expect(journal.queuedMessages.get(edit.messageId)).toMatchObject({
    state: 'waiting',
    body: {
      blocks: [
        { type: 'text', text: 'changed' },
        { type: 'image-ref', path: '/image.png' }
      ]
    }
  })
  expect(journal.queuedMessages.get(retry.messageId)?.state).toBe('dispatched')
  expect(journal.queuedMessages.list().filter((c) => c.state === 'returned')).toEqual([])
})

it('does not end observation from warnings, retry errors or another attempt’s explicit end', async () => {
  await send('U')
  for (const [kind, payload] of [
    ['notification:warning', '{}'],
    ['notification:error', '{"willRetry":true}']
  ] as const) {
    await journal.appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: kind },
      {
        kind: 'status',
        text: 'provider notice',
        providerFrame: {
          provider: 'codex',
          kind,
          payload: { head: payload, byteLength: payload.length, digest: '', truncated: false }
        }
      },
      { fence: 7, turnScope: { kind: 'thread' } }
    )
  }
  await journal.appendItem(
    { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: 'other-end' },
    {
      kind: 'turn',
      turnId: 'other',
      state: 'completed',
      userItemId: agentJournalSubmissionKey('other-input')
    },
    { fence: 7, turnScope: { kind: 'thread' } }
  )
  expect(journal.queuedMessages.attemptEnded('U')).toBe(false)
  expect(journal.queuedMessages.get(cardId('U'))).toBeNull()
  await ended('U-end')
  expect(journal.queuedMessages.attemptEnded('U')).toBe(true)
})

it.each([100, 1000])(
  'does no accepted-history or spent-card visits per streamed row at N=%i',
  async (count) => {
    const { applyJournalRow } = await import('./journal-reducer')
    const state = journal.queuedMessages.displayState()
    const base = () => ({
      v: 1,
      epoch: state.epoch,
      seq: state.lastSequence + 1,
      fence: 7,
      ts: clock++
    })
    for (let i = 0; i < count; i++) {
      applyJournalRow(state, {
        kind: 'submission',
        clientMessageId: `old-${i}`,
        payloadFingerprint: 'old',
        providerHandle: agentSessionJournalProviderHandle(identity),
        body: body('old'),
        ...base()
      })
      applyJournalRow(state, {
        kind: 'dispatch',
        clientMessageId: `old-${i}`,
        state: 'accepted',
        providerItemId: null,
        reason: null,
        ...base()
      })
      applyJournalRow(state, {
        kind: 'queue',
        messageId: `spent-${i}`,
        change: { op: 'queued', body: body('spent'), position: i, queuedAt: null },
        ...base()
      })
      applyJournalRow(state, {
        kind: 'queue',
        messageId: `spent-${i}`,
        change: { op: 'withdrawn' },
        ...base()
      })
    }
    const gate = () => ({ work: work(), record: records.agentSessionRecordFixture(lease) })
    readQueuePublication(journal, gate)
    let visits = 0
    const sends = state.submissions.values.bind(state.submissions)
    const cards = state.queue.cards.values.bind(state.queue.cards)
    function* counted<T>(values: Iterable<T>) {
      for (const value of values) {
        visits++
        yield value
      }
      return undefined
    }
    vi.spyOn(state.submissions, 'values').mockImplementation(() => counted(sends()))
    vi.spyOn(state.queue.cards, 'values').mockImplementation(() => counted(cards()))
    const key = journal.queuedMessages.revision()
    for (let i = 0; i < 10; i++) {
      await journal.appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: 'stream' },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: String(i) }] },
        { fence: 7, turnScope: { kind: 'thread' } }
      )
      readQueuePublication(journal, gate)
    }
    expect(journal.queuedMessages.revision()).toBe(key)
    expect(visits).toBe(0)
    vi.restoreAllMocks()
    await send('candidate')
    held.add('candidate')
    await ended('candidate-end')
    expect(journal.queuedMessages.get(cardId('candidate'))).toBeNull()
    held.delete('candidate')
    expect(journal.queuedMessages.get(cardId('candidate'))).toBeNull()
    expect(journal.queuedMessages.attemptEnded('candidate')).toBe(true)
    await receipt('candidate')
    expect(journal.queuedMessages.get(cardId('candidate'))).toBeNull()
    const { structuredAgentSessionCommandTurnIdentity } =
      await import('../../../shared/structured-agent-session-command-turn-identity')
    const command = { ...body('/compact'), command: { name: 'compact' as const } }
    applyJournalRow(state, {
      kind: 'queue',
      messageId: 'command',
      change: {
        op: 'queued',
        body: command,
        position: 0,
        queuedAt: null,
        attempt: 'command-send',
        returned: { reason: 'refused' }
      },
      ...base()
    })
    expect(state.queue.cards.get('command')?.state).toBe('returned')
    await journal.appendItem(
      structuredAgentSessionCommandTurnIdentity('command-send'),
      { kind: 'turn', turnId: 'compact:command-send', state: 'completed' },
      { fence: 7, turnScope: { kind: 'thread' } }
    )
    expect(state.queue.cards.get('command')?.state).toBe('withdrawn')
  }
)

it('retains an ordinary consumed payload and attempt across failed replacement, boundary and restart', async () => {
  const payload: AgentJournalMessageItem = {
    ...body('full input'),
    blocks: [
      { type: 'text', text: 'full input' },
      { type: 'image-ref', path: '/full.png' }
    ]
  }
  await journal.queuedMessages.insert({
    messageId: 'Q',
    body: payload,
    options: { model: 'gpt-5' }
  })
  const card = journal.queuedMessages.get('Q')!
  await journal.appendSubmission(
    {
      clientMessageId: 'U',
      body: payload,
      payloadFingerprint: card.fingerprint,
      fence: 7,
      origin: 'client',
      handoverRecorded: true,
      options: card.options
    },
    { messageId: 'Q', expect: 'waiting' }
  )
  const original = journal.submission('U')!
  const before = journal.cursor()
  await expect(
    journal.replaceEpochItems('handle_forked', 7, [], () => ({
      write: () => {
        throw new Error('write failed')
      },
      committed: () => {}
    }))
  ).rejects.toThrow('write failed')
  expect(journal.cursor()).toEqual(before)
  expect(journal.submission('U')).toEqual(original)
  await journal.replaceEpochItems('handle_forked', 7, [])
  await journal.close()
  await open()
  expect(journal.submissionBody('U')).toEqual(payload)
  expect(journal.submission('U')).toEqual(original)
  expect(journal.queuedMessages.get('Q')).toMatchObject({
    state: 'dispatched',
    consumedAs: 'U',
    options: card.options
  })
  expect(
    nextSendableQueuedCard(journal.queuedMessages.pauses(), journal.queuedMessages.list())
  ).toBeNull()
  await journal.acceptLate({
    clientMessageId: 'U',
    state: 'accepted',
    fence: 7,
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'late', ordinal: 0 }
  })
  expect(journal.submission('U')?.dispatchState).toBe('accepted')
  expect(journal.queuedMessages.get('Q')?.consumedAs).toBe('U')
  expect(
    nextSendableQueuedCard(journal.queuedMessages.pauses(), journal.queuedMessages.list())
  ).toBeNull()
})

it('indexes queue-restored unknown for an ordinary card and a retained recovery successor', async () => {
  await send('original')
  await ended('original-end')
  const recovery = savedCopy('original')
  await journal.appendSubmission(
    {
      clientMessageId: 'V',
      body: recovery.body,
      payloadFingerprint: recovery.fingerprint,
      fence: 7,
      origin: 'client',
      handoverRecorded: true
    },
    { messageId: recovery.messageId, expect: 'waiting' }
  )
  await journal.queuedMessages.insert({ messageId: 'ordinary', body: body('ordinary') })
  const ordinary = journal.queuedMessages.get('ordinary')!
  await journal.appendSubmission(
    {
      clientMessageId: 'U',
      body: ordinary.body,
      payloadFingerprint: ordinary.fingerprint,
      fence: 7,
      origin: 'client',
      handoverRecorded: true
    },
    { messageId: ordinary.messageId, expect: 'waiting' }
  )
  for (const id of ['U', 'V']) {
    await journal.resolveDispatch({
      clientMessageId: id,
      state: 'pending',
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.resolveDispatch({
      clientMessageId: id,
      state: 'rejected',
      fence: 7,
      recovered: true,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      answeredInTurn: {
        turn: { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: 'ended' },
        via: 'start'
      }
    })
    expect(journal.submission(id)?.dispatchState).toBe('unknown')
    expect(journal.queuedMessages.get(cardId(id))).toBeNull()
    expect(journal.submissionBody(id)).toBeDefined()
  }
  await journal.replaceEpochItems('handle_forked', 7, [])
  await journal.close()
  await open()
  for (const id of ['U', 'V']) {
    expect(journal.queuedMessages.get(cardId(id))).toBeNull()
    expect(journal.submissionBody(id)).toBeDefined()
    await journal.acceptLate({
      clientMessageId: id,
      state: 'accepted',
      fence: 7,
      providerIdentity: {
        provider: 'codex',
        threadId: 'thread',
        turnId: 'late',
        ordinal: id === 'U' ? 0 : 1
      }
    })
    expect(journal.submission(id)?.dispatchState).toBe('accepted')
    expect(journal.queuedMessages.get(cardId(id))).toBeNull()
    expect(journal.itemBody(agentJournalSubmissionKey(id))).toBeNull()
  }
})
