import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  SESSION,
  tick,
  rig,
  mutation,
  turn,
  words,
  batch
} from './chat-worker-request-failure-rig.test-fixture'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailure } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { recordStructuredAgentSessionStartFailure } from '../../native-chat/agent-session-wire/structured-agent-session-start-failure-row'
import type { StructuredAgentSessionEndedChild } from '../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { hostTestMessage } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { countChatFailureOperations } from './chat-worker-error-operation-counts.test-support'
import { settleStructuredAgentSessionChildExit } from '../../native-chat/agent-session-wire/structured-agent-session-child-exit'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'

it.each([100, 1000])(
  'bounds real committed observation and one failure with %i saved requests',
  async (n) => {
    const r = await rig()
    r.sessions.delete(SESSION)
    for (let index = 0; index < n; index++) {
      await r.journal.appendSubmission({
        clientMessageId: `history:${index}`,
        payloadFingerprint: `history:${index}`,
        body: hostTestMessage('saved input'),
        fence: 0
      })
    }
    await batch(
      r.journal,
      'history',
      Array.from({ length: n }, (_, index) => turn(`history-turn:${index}`, 'success'))
    )
    const ops = await countChatFailureOperations(r.journal, r.root, n)
    r.sessions.set(SESSION, r.session)
    const adoption = { ...ops.counts }
    expect(adoption).toMatchObject({
      baselineItems: 2 * n,
      runningTurnScans: 0,
      runningTurnItems: 0,
      itemLookups: 3 * n,
      submissionsCopied: n,
      submissionVisits: n,
      lineageCopied: 0,
      lineageVisits: 0,
      snapshots: 0,
      projectedItems: 0,
      orderingComparisons: 0,
      materializedItems: 0,
      materializedSubmissions: 0,
      wordItemReads: 0,
      wordSubmissionReads: 0,
      bodyLookups: 0
    })
    await batch(r.journal, 'live-turn', [
      mutation('live-turn', { kind: 'turn', turnId: 'live-turn', state: 'running' })
    ])
    ops.reset()
    // Ten revisions of one live output exercise the real synchronous commit observer.
    for (let index = 0; index < 10; index++) {
      await batch(r.journal, `token:${index}`, [
        mutation(
          'live-output',
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `token ${index}` }]
          },
          'live-turn'
        )
      ])
    }
    const incremental = { ...ops.counts }
    expect(incremental).toEqual({
      baselineItems: 0,
      runningTurnScans: 0,
      runningTurnItems: 0,
      itemLookups: 30,
      bodyLookups: 10,
      submissionsCopied: 0,
      submissionVisits: 0,
      lineageCopied: 0,
      lineageVisits: 0,
      snapshots: 0,
      projectedItems: 0,
      orderingComparisons: 0,
      materializedItems: 0,
      materializedSubmissions: 0,
      wordItemReads: 0,
      wordSubmissionReads: 0
    })
    await r.journal.appendSubmission({
      clientMessageId: 'eligible',
      payloadFingerprint: 'eligible',
      body: hostTestMessage('fail'),
      fence: 0
    })
    ops.reset()
    await batch(r.journal, 'eligible-failure', [
      mutation('eligible-turn', {
        kind: 'turn',
        turnId: 'eligible-turn',
        state: 'completed',
        outcome: 'failure',
        userItemId: agentJournalSubmissionKey('eligible')
      }),
      words('eligible-turn', 'exact eligible error')
    ])
    await tick()
    const failure = { ...ops.counts }
    expect(r.mail()).toHaveLength(1)
    expect(r.mail()[0]?.body).toContain('exact eligible error')
    expect(failure).toMatchObject({
      baselineItems: 0,
      runningTurnScans: 0,
      runningTurnItems: 0,
      itemLookups: 4,
      bodyLookups: 4,
      submissionsCopied: n + 1,
      submissionVisits: n + 1,
      lineageCopied: 2 * n,
      lineageVisits: 2 * n,
      snapshots: 1,
      projectedItems: 2 * n + 5,
      materializedItems: 2 * n + 5,
      materializedSubmissions: n + 1,
      wordItemReads: 4 * n + 11,
      wordSubmissionReads: n + 1
    })
    expect(failure.orderingComparisons).toBeGreaterThanOrEqual(2 * n + 4)
    expect(failure.orderingComparisons).toBeLessThanOrEqual(
      (2 * n + 5) * Math.ceil(Math.log2(2 * n + 5))
    )
    process.stdout.write(
      `CHAT_FAILURE_OPERATIONS ${JSON.stringify({ n, adoption, incremental, failure })}\n`
    )
  }
)

it.each([100, 1000])('bounds the native root-end scan with %i saved items', async (n) => {
  for (const state of ['running', 'completed'] as const) {
    const r = await rig()
    r.sessions.delete(SESSION)
    await batch(
      r.journal,
      'saved-native-turns',
      Array.from({ length: n }, (_, index) =>
        mutation(`native:${index}`, {
          kind: 'turn',
          turnId: `native:${index}`,
          state: index === n - 1 ? state : 'completed',
          ...(index === n - 1 && state === 'running' ? {} : { outcome: 'success' })
        })
      )
    )
    const ops = await countChatFailureOperations(r.journal, r.root, n)
    r.session.child = { generation: 'native-generation', fence: 0, phase: 'ready' }
    r.sessions.set(SESSION, r.session)
    let record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: SESSION, runtimeFence: 0 })
    )
    const store = {
      getRecord: (_sessionId: string) => record,
      transitionHandoff: async (
        _sessionId: string,
        transition: (current: AgentSessionRecord) => AgentSessionRecord
      ) => (record = transition(record))
    }
    const log = recordingStructuredAgentSessionLogger()
    const observations: { scans: number; items: number; results: (string | null)[] }[] = []
    ops.reset()
    await settleStructuredAgentSessionChildExit(
      {
        store,
        sessions: r.sessions,
        logger: log.logger,
        now: () => 1000,
        serialize: async (_sessionId, task) => task(),
        flushLifecycle: async () => ({ ok: true }),
        generationEnded: (sessionId) => {
          const scans = ops.counts.runningTurnScans
          const items = ops.counts.runningTurnItems
          const results = ops.runningTurns.length
          r.observer.generationEnded(sessionId)
          observations.push({
            scans: ops.counts.runningTurnScans - scans,
            items: ops.counts.runningTurnItems - items,
            results: ops.runningTurns.slice(results)
          })
        }
      },
      {
        type: 'ended',
        sessionId: SESSION,
        acquisitionGeneration: 'native-generation',
        fence: 0,
        cause: 'unexpected-exit',
        reason: 'native root exited'
      }
    )
    await tick()
    process.stdout.write(
      `NATIVE_END_OPERATIONS ${JSON.stringify({ n, state, observations, counts: ops.counts, logs: log.entries })}\n`
    )
    expect(observations).toEqual([
      { scans: 1, items: n, results: [state === 'running' ? `native:${n - 1}` : null] },
      { scans: 0, items: 0, results: [] }
    ])
    expect(ops.counts.runningTurnScans).toBe(1)
    expect(ops.counts.runningTurnItems).toBe(n)
    expect(ops.runningTurns).toEqual([state === 'running' ? `native:${n - 1}` : null])
    expect(r.session.child).toBeNull()
    expect(r.session.lastEndedChild).toMatchObject({ cause: 'exit', rootGone: true, fence: 0 })
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    expect(log.entries).toEqual([])
    expect(r.mail()).toHaveLength(state === 'running' ? 1 : 0)
    expect(r.db.getDispatchContextById(r.dispatch().id)?.status).toBe('dispatched')
    vi.restoreAllMocks()
  }
})

it('captures every failed request before latest-only publication, despite owed work and pending prompts', async () => {
  const r = await rig()
  await r.journal.appendSubmission({
    clientMessageId: 'owed',
    payloadFingerprint: 'owed',
    body: hostTestMessage('next'),
    fence: 0
  })
  const held: (() => void)[] = []
  const queued = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    held.push(callback)
  })
  try {
    await batch(r.journal, 'A', [
      turn('A', 'failure'),
      words('A', 'capacity A'),
      {
        ...mutation('child-prompt', {
          kind: 'approval',
          title: 'Run?',
          detail: null,
          options: [{ id: 'yes', label: 'Allow' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }),
        linkage: { agentId: 'child-1' }
      }
    ])
    await batch(r.journal, 'B', [turn('B', 'success')])
    await batch(r.journal, 'C+D', [
      turn('C', 'failure'),
      mutation(
        'quota:C',
        {
          kind: 'status',
          tone: 'warning',
          ...agentSessionFailureWords(
            { kind: 'usageLimitReached' },
            { surface: 'row', agentName: 'Codex' }
          )
        },
        'C'
      ),
      turn('D', 'failure'),
      words('D', 'quota D')
    ])
  } finally {
    queued.mockRestore()
  }
  expect(held).toHaveLength(1)
  held.forEach((callback) => callback())
  await tick()
  expect(r.mail().map((m) => JSON.parse(m.payload ?? '{}').error)).toEqual([
    'capacity A',
    agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row', agentName: 'Codex' })
      .text,
    'quota D'
  ])
  expect(r.db.getDispatchContextById(r.dispatch().id)?.status).toBe('dispatched')
  // Refusing bookkeeping never changes the durable next-send path.
  r.notify.mockImplementation(() => {
    throw new Error('notification unavailable')
  })
  const longError = 'Provider returned a detailed failure sentence. '.repeat(50)
  await batch(r.journal, 'E', [turn('E', 'failure'), words('E', longError)])
  await tick()
  expect(r.mail().at(-1)?.body).toContain(longError)
  await r.journal.appendSubmission({
    clientMessageId: 'after',
    payloadFingerprint: 'after',
    body: hostTestMessage('recover'),
    fence: 0
  })
  expect(r.journal.submission('after')?.dispatchState).toBe('pending')
})

it('keeps each request’s own saved error when another start fails before the detached read', async () => {
  const r = await rig()
  await r.journal.appendSubmission({
    clientMessageId: 'B',
    payloadFingerprint: 'B',
    body: hostTestMessage('B'),
    fence: 0,
    handoverRecorded: true
  })
  await batch(r.journal, 'A', [turn('A', 'failure'), words('A', 'capacity from A')])
  const refused = agentSessionFailureWords(
    { kind: 'cliMissing' },
    { surface: 'rejection', agentName: 'Codex' }
  )
  await recordStructuredAgentSessionStartFailure(
    { journal: r.journal, fence: 0 },
    { startKey: 'B-start', ...refused },
    'B'
  )
  await tick()
  expect(r.mail().map((message) => JSON.parse(message.payload ?? '{}'))).toMatchObject([
    { requestId: 'A', error: 'capacity from A' },
    { requestId: 'orca:B', error: refused.reason }
  ])
  expect(r.db.getDispatchContextById(r.dispatch().id)?.status).toBe('dispatched')
})

it('delivers a captured live failure when the same journal clears context before the detached read', async () => {
  const r = await rig()
  await batch(r.journal, 'A', [turn('A', 'failure'), words('A', 'failure before clear')])
  await r.journal.context.clear(
    { operationId: 'clear-after-A', afterFence: 0, clearedAt: 1 },
    { write: () => {}, committed: () => {} }
  )
  await tick()
  expect(r.mail().map((message) => JSON.parse(message.payload ?? '{}'))).toMatchObject([
    { requestId: 'A', error: 'failure before clear' }
  ])
})

it.each(['history', 'close', 'replacement', 'epoch'] as const)(
  'invalidates a captured read on %s before the detached read',
  async (change) => {
    const r = await rig()
    const replacement = change === 'replacement' ? (await rig()).session : r.session
    await batch(r.journal, 'A', [turn('A', 'failure'), words('A', 'obsolete failure')])
    if (change === 'history') {
      r.observer.observe(SESSION, r.journal)
    } else if (change === 'close') {
      r.sessions.delete(SESSION)
    } else if (change === 'replacement') {
      r.sessions.set(SESSION, replacement)
    } else {
      await r.journal.replaceEpochItems('handle_forked', 0, [])
    }
    await tick()
    expect(r.mail()).toHaveLength(0)
  }
)

it('consumes disabled/unassigned failures and baselines adoption, epoch replacement and changed assignments', async () => {
  const r = await rig()
  r.sessions.delete(SESSION)
  await batch(r.journal, 'saved-history', [
    ...Array.from({ length: 2_000 }, (_, index) =>
      mutation(`history:${index}`, { kind: 'status', text: `saved output ${index}` })
    ),
    turn('saved-failure', 'failure'),
    words('saved-failure', 'historic error')
  ])
  r.sessions.set(SESSION, r.session)
  const deltaQuery = vi.spyOn(r.journal, 'readSince')
  r.enabled(false)
  await batch(r.journal, 'old', [turn('old', 'failure'), words('old', 'old error')])
  r.unassign()
  r.enabled(true)
  await batch(r.journal, 'unassigned', [
    turn('unassigned', 'failure'),
    words('unassigned', 'no assignment')
  ])
  r.reassign()
  r.observer.observe(SESSION, r.journal)
  r.sessions.delete(SESSION)
  r.sessions.set(SESSION, r.session)
  await r.journal.replaceEpochItems('handle_forked', 0, [])
  await tick()
  expect(r.mail()).toHaveLength(0)
  await batch(r.journal, 'new', [turn('new', 'failure'), words('new', 'new error')])
  r.reassign() // The captured assignment ended before the deferred read.
  await tick()
  expect(r.mail()).toHaveLength(0)
  await batch(r.journal, 'fresh', [turn('fresh', 'failure'), words('fresh', 'fresh error')])
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.mail()[0]?.body).toContain('fresh error')
  await batch(r.journal, 'clear-context', [
    mutation('clear', {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear-1', afterFence: 0, clearedAt: 1 }
    })
  ])
  await batch(r.journal, 'new-context', [
    turn('post-clear', 'failure'),
    words('post-clear', 'new context error')
  ])
  await tick()
  expect(r.mail()).toHaveLength(2)
  expect(r.mail()[1]?.body).toContain('new context error')
  expect(deltaQuery).not.toHaveBeenCalled()
})

it('normalizes linked refused starts, reads explicitly scoped late words past a newer turn and retains hostStopped', async () => {
  const r = await rig()
  await r.journal.appendSubmission({
    clientMessageId: 'start',
    payloadFingerprint: 'start',
    body: hostTestMessage('start'),
    fence: 0
  })
  const identity = {
    provider: 'codex' as const,
    threadId: 'thread-1',
    turnId: 'start-turn',
    ordinal: 0
  }
  const started = await r.journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'start-turn', state: 'running' },
    { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await r.journal.appendLifecycleBatch({
    settlementId: 'failed-start',
    fence: 0,
    dispatches: [
      {
        clientMessageId: 'start',
        fence: 0,
        state: 'rejected',
        ...agentSessionFailureWords(
          { kind: 'providerRejected', detail: { text: 'specific refusal', audience: 'person' } },
          { surface: 'rejection', agentName: 'Codex' }
        ),
        answeredInTurn: { turn: identity, via: 'start' }
      }
    ],
    mutations: [turn(started.itemId, 'failure'), turn('newer', 'success')]
  })
  await batch(r.journal, 'late', [words(started.itemId, 'precise saved sentence')])
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.mail()[0]?.body).toContain('Error: precise saved sentence')
  expect(r.mail()[0]?.body).toContain('Details from the agent:')
  expect(r.mail()[0]?.body).toContain('specific refusal')
  await r.journal.appendSubmission({
    clientMessageId: 'hung',
    payloadFingerprint: 'hung',
    body: hostTestMessage('hung'),
    fence: 0
  })
  await r.journal.resolveDispatch({
    clientMessageId: 'hung',
    fence: 0,
    state: 'rejected',
    ...agentSessionFailureWords(
      { kind: 'hostStopped' },
      { surface: 'rejection', agentName: 'Codex' }
    ),
    recovered: true
  })
  await tick()
  expect(r.mail()).toHaveLength(2)
  await batch(r.journal, 'off-at-read', [
    turn('off-at-read', 'failure'),
    words('off-at-read', 'muted before read')
  ])
  r.enabled(false)
  await tick()
  expect(r.mail()).toHaveLength(2)
})

it('announces proven live death before cleanup, deduplicates settlement, and excludes requested or unproven ends', async () => {
  const r = await rig()
  const ended = (
    cause: StructuredAgentSessionEndedChild['cause'],
    rootGone = true,
    fence = 0
  ): StructuredAgentSessionEndedChild => ({
    generation: 'generation-1',
    fence,
    cause,
    rootGone,
    reason: null,
    duringStartup: false,
    endedAt: r.journal.cursor()
  })
  for (const cause of ['user-close', 'evict', 'context-clear', 'user-stop'] as const) {
    for (const withRow of [false, true]) {
      const requestId = `${cause}:${withRow}`
      await batch(r.journal, `running-${cause}-${withRow}`, [
        mutation(requestId, { kind: 'turn', turnId: requestId, state: 'running' }),
        ...(withRow ? [words(requestId, 'old error row')] : [])
      ])
      r.session.lastEndedChild = ended(cause)
      r.observer.generationEnded(SESSION)
      await batch(r.journal, `closed-${cause}-${withRow}`, [
        mutation(requestId, { kind: 'turn', turnId: requestId, state: 'interrupted' })
      ])
    }
  }
  await batch(r.journal, 'running-stopped', [
    mutation('stopped', { kind: 'turn', turnId: 'stopped', state: 'running' })
  ])
  await r.journal.appendStopEvent({ reason: 'user-stop', turnId: 'stopped' }, 0)
  r.session.lastEndedChild = ended('exit')
  r.observer.generationEnded(SESSION)
  await batch(r.journal, 'settled-stopped', [
    mutation('stopped', { kind: 'turn', turnId: 'stopped', state: 'interrupted' })
  ])
  await batch(r.journal, 'running-dead', [
    mutation('dead', { kind: 'turn', turnId: 'dead', state: 'running' })
  ])
  r.session.lastEndedChild = ended('exit', false)
  r.observer.generationEnded(SESSION)
  r.session.lastEndedChild = ended('exit', true, 9)
  r.observer.generationEnded(SESSION)
  await tick()
  expect(r.mail()).toHaveLength(0)
  r.session.lastEndedChild = ended('exit')
  r.observer.generationEnded(SESSION)
  // Cleanup has not written anything: the original running row is still durable.
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.mail()[0]?.body).toContain('Codex')
  await batch(r.journal, 'cleanup', [
    mutation('dead', { kind: 'turn', turnId: 'dead', state: 'interrupted' }),
    words('dead', 'exit detail')
  ])
  await tick()
  expect(r.mail()).toHaveLength(1) // Late-diagnostic policy is deliberately pending.
})

it('uses the original malformed saved submission through its canonical opener, never its bounded digest', async () => {
  const capture = vi.fn(() => () => false)
  const r = await rig(capture)
  const clientMessageId = `saved-${'x'.repeat(1100)}-\ud800`
  await r.journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: 'malformed',
    body: hostTestMessage('saved'),
    fence: 0
  })
  r.session.child = { generation: 'held-generation', fence: 0, phase: 'ready' }
  await batch(r.journal, 'failed-saved', [
    mutation('saved-turn', {
      kind: 'turn',
      turnId: 'saved-turn',
      state: 'completed',
      outcome: 'failure',
      userItemId: agentJournalSubmissionKey(clientMessageId)
    }),
    words('saved-turn', 'saved failure')
  ])
  await tick()
  expect(capture).toHaveBeenCalledExactlyOnceWith({
    sessionId: SESSION,
    clientMessageId,
    fence: 0,
    generation: 'held-generation'
  })
  expect(r.mail()[0]?.body).toContain('saved failure')
})

it.each(['startup', 'ordinary', 'scoped', 'committed'] as const)(
  'captures %s death wording before cleanup without awaiting ACP or borrowing a newer end',
  async (mode) => {
    const capture = vi.fn(() => () => true)
    const r = await rig(capture)
    await batch(r.journal, 'running', [
      mutation('dying', { kind: 'turn', turnId: 'dying', state: 'running' }),
      ...(mode === 'scoped' ? [words('dying', 'meaningful saved diagnostic')] : [])
    ])
    const failure = {
      kind: 'providerExited' as const,
      detail: { text: 'exact original exit detail', audience: 'person' as const }
    }
    r.session.lastEndedChild = {
      generation: 'old',
      fence: 0,
      cause: 'exit',
      rootGone: true,
      reason: null,
      duringStartup: mode === 'startup' || mode === 'committed',
      failure,
      endedAt: r.journal.cursor()
    }
    if (mode === 'committed') {
      await batch(r.journal, 'explicit', [
        turn('dying', 'failure'),
        words('dying', 'explicit failure words')
      ])
    } else {
      r.observer.generationEnded(SESSION)
    }
    r.session.lastEndedChild = {
      ...r.session.lastEndedChild,
      generation: 'new',
      failure: {
        kind: 'providerExited',
        detail: { text: 'unrelated B detail', audience: 'person' }
      }
    }
    if (mode !== 'scoped' && mode !== 'committed') {
      await batch(r.journal, 'generic-cleanup', [
        mutation('dying', { kind: 'turn', turnId: 'dying', state: 'interrupted' }),
        mutation(
          'cleanup-error',
          {
            kind: 'status',
            tone: 'error',
            ...agentSessionFailureWords(
              { kind: 'providerExited' },
              { agentName: 'Codex', surface: 'row' }
            )
          },
          'dying'
        )
      ])
    }
    await tick()
    expect(r.mail()).toHaveLength(1)
    const body = r.mail()[0]?.body ?? ''
    if (mode === 'startup') {
      expect(body).toContain(
        structuredAgentSessionStartFailure(
          { exit: failure },
          { agentName: 'Codex', retryControl: true }
        ).reason
      )
    } else if (mode === 'scoped') {
      expect(body).toContain('Error: meaningful saved diagnostic')
    } else if (mode === 'committed') {
      expect(body).toContain('Error: explicit failure words')
    } else {
      expect(body).toContain('exact original exit detail')
    }
    expect(body).not.toContain('unrelated B detail')
    expect(capture).not.toHaveBeenCalled()
    await batch(r.journal, 'later', [words('dying', 'later cleanup words')])
    await tick()
    expect(r.mail()).toHaveLength(1)
  }
)
