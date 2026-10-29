import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import * as journalFactory from '../agent-session-journal/journal-store-factory'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import {
  savedStructuredAgentSessionStatus,
  StructuredAgentSessionSavedStatus
} from './structured-agent-session-saved-status'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  adapter,
  attach,
  hostTestState,
  CALLER,
  envelope,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  interruptedRestart,
  QUEUED_BEFORE_QUIT
} from './structured-agent-session-restart-interruption-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { savedStatusContracts } from '../../../shared/agent-session-saved-status.test-fixture'

afterEach(() => vi.restoreAllMocks())

it('maps saved turn edges and legacy markers without using rename time', () => {
  for (const contract of savedStatusContracts) {
    expect(
      savedStructuredAgentSessionStatus(agentSessionConversationView(contract.record))
    ).toEqual(contract.summary)
  }
  const record = agentSessionConversationView({ ...agentSessionRecordFixture(), updatedAt: 99_000 })
  expect(savedStructuredAgentSessionStatus(record)).toMatchObject({
    status: null,
    updatedAt: record.createdAt
  })
  expect(savedStructuredAgentSessionStatus(record, 35)).toMatchObject({
    status: 'idle',
    turnOutcome: 'cancellation',
    statusStartedAt: 35
  })
  expect(
    savedStructuredAgentSessionStatus({
      ...record,
      lastTurn: { state: 'open', at: 40, prompt: 'hello' }
    })
  ).toMatchObject({
    status: 'idle',
    turnOutcome: 'cancellation',
    statusStartedAt: 40,
    updatedAt: 40,
    latestPrompt: 'hello'
  })
  expect(
    savedStructuredAgentSessionStatus(
      { ...record, lastTurn: { state: 'settled', outcome: 'success', at: 50, reply: 'finished' } },
      35
    )
  ).toMatchObject({
    status: 'idle',
    turnOutcome: 'success',
    statusStartedAt: 50,
    lastAssistantMessage: 'finished'
  })
  expect(
    savedStructuredAgentSessionStatus({
      ...record,
      sleptAt: 60,
      lastTurn: { state: 'open', at: 40 }
    })
  ).toMatchObject({ sleptAt: 60 })
})

it('seeds first desktop and phone snapshots without opening, writing or reacting', () => {
  const record = agentSessionConversationView({
    ...agentSessionRecordFixture(),
    lastTurn: { state: 'open', at: 40 } as const
  })
  const reaction = vi.fn()
  const write = vi.fn()
  const sink = { publish: vi.fn(), forget: vi.fn() }
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map(),
    getConversation: () => record,
    now: () => 99_000,
    logger: createStructuredAgentSessionLogger(),
    onStatusChanged: reaction,
    onAgentStarted: reaction,
    onPublished: write,
    statusSink: () => sink
  })
  const events: AgentSessionStatusEvent[] = []
  feed.publishSavedGroup((publish) => publish(record))
  feed.subscribe({ id: 'first-client', emit: (event) => events.push(event) })
  expect(events).toContainEqual({
    type: 'snapshot',
    sessions: [
      expect.objectContaining({ sessionId: record.sessionId, turnOutcome: 'cancellation' })
    ]
  })
  expect(sink.publish).toHaveBeenCalledWith(
    expect.objectContaining({ turnOutcome: 'cancellation' }),
    { ...record.location, kind: 'structured-session', sessionId: record.sessionId }
  )
  expect(reaction).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('writes turn and attention edges, ignores streamed previews, and clears an empty context', async () => {
  await attach()
  const { store, log } = hostTestState()
  const writer = new StructuredAgentSessionSavedStatus(() => ({ store, logger: log.logger }))
  const transition = vi.spyOn(store, 'transitionHandoff')
  const summary: AgentSessionStatusSummary = {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    agent: 'codex',
    status: 'working',
    latestPrompt: 'p'.repeat(400),
    statusStartedAt: 10,
    updatedAt: 99
  }
  writer.observe(summary)
  writer.observe({ ...summary, lastAssistantMessage: 'streamed', updatedAt: 100 })
  await writer.drain()
  expect(transition).toHaveBeenCalledTimes(1)
  expect(store.getRecord(SESSION)?.lastTurn).toEqual({
    state: 'open',
    at: 10,
    prompt: 'p'.repeat(280)
  })
  writer.observe({ ...summary, status: 'attention', statusStartedAt: 11 })
  writer.observe({
    ...summary,
    status: 'idle',
    turnOutcome: 'cancellation',
    statusStartedAt: 12,
    lastAssistantMessage: 'r'.repeat(400)
  })
  await writer.drain()
  expect(store.getRecord(SESSION)?.lastTurn).toMatchObject({
    state: 'settled',
    outcome: 'cancellation',
    at: 12,
    reply: 'r'.repeat(280)
  })
  // Rewinds and repeated refused sends can settle to the same outcome at a different edge.
  writer.observe({ ...summary, status: 'idle', turnOutcome: 'cancellation', statusStartedAt: 13 })
  await writer.drain()
  expect(store.getRecord(SESSION)?.lastTurn?.at).toBe(13)
  writer.observe({ ...summary, status: null, latestPrompt: '', statusStartedAt: undefined })
  await writer.drain()
  expect(store.getRecord(SESSION)?.lastTurn).toBeUndefined()
  expect(transition).toHaveBeenCalledTimes(5)
  writer.observe({ ...summary, status: 'idle', turnOutcome: 'failure', statusStartedAt: 14 })
  writer.observe({ ...summary, status: 'idle', turnOutcome: 'failure', statusStartedAt: 15 })
  await writer.drain()
  expect(store.getRecord(SESSION)?.lastTurn).toMatchObject({ outcome: 'failure', at: 15 })
  writer.observe({ ...summary, statusStartedAt: 16 })
  writer.observe({ ...summary, status: null, latestPrompt: '', statusStartedAt: undefined })
  await writer.drain()
  expect(store.getRecord(SESSION)?.lastTurn).toBeUndefined()
})

it.each(['quit', 'stop', 'failure', 'provider-death'] as const)(
  'keeps the displayed %s verdict through graceful drain, saved first paint and demand open',
  async (ending) => {
    await attach()
    const { host: original, store, acquire } = hostTestState()
    await store.setSessionTabVisibility(SESSION, true)
    const body = hostTestMessage('finish this after restart')
    await original.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    const events = acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('provider event sink missing')
    }
    events.appendItem({ provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }, body, {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await original.flushStreamedEvents(SESSION)
    await original.drainStatusWrites()
    expect(store.getRecord(SESSION)?.lastTurn?.state).toBe('open')
    if (ending === 'stop') {
      await seedApproval()
      await original.drainStatusWrites()
      expect(store.getRecord(SESSION)?.lastTurn).toMatchObject({
        state: 'open',
        prompt: 'finish this after restart'
      })
      await original.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
        turnId: 'turn-1'
      })
    }
    if (ending === 'provider-death') {
      const generation = (await acquire.mock.results.at(-1)?.value)?.acquisitionGeneration
      const fence = store.getRecord(SESSION)?.lease.runtimeFence
      if (!generation || fence === undefined) {
        throw new Error('provider identity missing')
      }
      await original.handleAdapterEvent({
        type: 'ended',
        sessionId: SESSION,
        reason: 'provider crashed',
        cause: 'unexpected-exit',
        fence,
        acquisitionGeneration: generation
      })
    } else if (ending === 'failure' || ending === 'stop') {
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
        {
          kind: 'turn',
          turnId: 'turn-1',
          state: 'completed',
          outcome: ending === 'stop' ? 'cancellation' : 'failure'
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await original.flushStreamedEvents(SESSION)
    }
    await original.flushAllStreamedEvents()
    await original.drainStatusWrites()
    const intentional = ending === 'quit' || ending === 'stop'
    const outcome = intentional ? 'cancellation' : ending === 'failure' ? 'failure' : 'interruption'
    expect(store.getRecord(SESSION)?.lastTurn).toMatchObject({ state: 'settled', outcome })
    const restarted = new StructuredAgentSessionHost({ ...original.deps, adapter: adapter() })
    try {
      const openJournal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
      await restarted.reconcileRestartLeases()
      await restarted.seedSessionTabs([SESSION])
      expect(openJournal).not.toHaveBeenCalled()
      for (const open of [false, true]) {
        if (open) {
          await restarted.revealSession(SESSION)
          await restarted.drainStatusWrites()
        }
        const summary = restarted.readStatusSummary(SESSION)
        if (!summary?.status) {
          throw new Error('restarted status missing')
        }
        expect(summary.turnOutcome).toBe(outcome)
        const row = structuredAgentSessionAgentStatus({ ...summary, status: summary.status })
        expect(agentVerdictDisplayMark(row)).toBe(intentional ? 'interrupted' : 'failed')
      }
      expect(openJournal).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lastTurn).toMatchObject({ state: 'settled', outcome })
    } finally {
      await restarted.flushAllStreamedEvents()
    }
  }
)

it('lists only indexed unopened chats, keeps legacy targets, and opens history on demand', async () => {
  await attach()
  const { host: original, store, acquire } = hostTestState()
  await store.setSessionTabVisibility(SESSION, true)
  const sink = acquire.mock.calls.at(-1)?.[0].events
  sink?.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'finished', ordinal: 1 },
    { kind: 'turn', turnId: 'finished', state: 'completed', outcome: 'success', completedAt: 123 },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await original.flushStreamedEvents(SESSION)
  await original.flushAllStreamedEvents()
  const reaction = vi.fn()
  const host = new StructuredAgentSessionHost({
    ...original.deps,
    adapter: adapter(),
    onSessionStatusChanged: reaction
  })
  try {
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lastTurn: { state: 'settled', outcome: 'success', at: 20 }
    }))
    const openJournal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    openJournal.mockClear()
    const transition = vi.spyOn(store, 'transitionHandoff')
    await host.seedSessionTabs([SESSION])
    expect(host.hasSession(SESSION)).toBe(false)
    expect(host.listSessionTabs()).toEqual([expect.objectContaining({ sessionId: SESSION })])
    expect(host.readStatusSummary(SESSION)).toMatchObject({
      turnOutcome: 'success',
      statusStartedAt: 20
    })
    expect(reaction).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    expect(openJournal).not.toHaveBeenCalled()
    await host.setSessionTabVisibility(SESSION, false)
    await host.seedSessionTabs()
    expect(host.listSessionTabs()).toEqual([])
    await host.setSessionTabVisibility(SESSION, true)
    expect(host.listSessionTabs()).toHaveLength(1)
    const capsule = host.deps.recoveryCapsule
    if (!capsule) {
      throw new Error('the fixture needs a recovery capsule')
    }
    const markers = Promise.withResolvers<AgentSessionResumeMarker[]>()
    vi.spyOn(capsule, 'list').mockReturnValueOnce(markers.promise)
    const seeding = host.seedSessionTabs()
    await host.setSessionTabVisibility(SESSION, false)
    markers.resolve([])
    await seeding
    expect(host.listSessionTabs()).toEqual([])
    await host.setSessionTabVisibility(SESSION, true)
    // An older build's chat backfills only when it is actually opened.
    await store.transitionHandoff(SESSION, ({ lastTurn: _turn, ...record }) => record)
    await host.revealSession(SESSION)
    await host.drainStatusWrites()
    expect(openJournal).toHaveBeenCalledOnce()
    expect(host.readStatusSummary(SESSION)).toMatchObject({
      turnOutcome: 'success',
      statusStartedAt: 123
    })
    expect(store.getRecord(SESSION)?.lastTurn).toMatchObject({
      state: 'settled',
      outcome: 'success',
      at: 123
    })
  } finally {
    await host.flushAllStreamedEvents()
  }
})

it('keeps queued leftovers closed at startup and shows their paused cards on demand', async () => {
  const { host, store } = await interruptedRestart('queued-cards')
  await host.setSessionTabVisibility(SESSION, true)
  await store.transitionHandoff(SESSION, ({ lastTurn: _lastTurn, ...record }) => record)
  const openJournal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
  openJournal.mockClear()
  await host.seedSessionTabs([SESSION])
  expect(host.hasSession(SESSION)).toBe(false)
  expect(host.readStatusSummary(SESSION)).toMatchObject({
    status: 'idle',
    turnOutcome: 'cancellation'
  })
  await host.restartResume.list()
  await host.restartResume.listFailures()
  expect(openJournal).not.toHaveBeenCalled()
  const history = await host.history({ sessionId: SESSION, direction: 'tail' })
  expect(history.ok).toBe(true)
  expect(history.ok && history.page.queuedMessages).toMatchObject(
    QUEUED_BEFORE_QUIT.map((text) => ({ state: 'waiting', body: hostTestMessage(text) }))
  )
  expect(
    host.collaboratorsForTests().sessions.get(SESSION)?.journal.queuedMessages.pauses()
  ).toMatchObject([{ reason: 'restarted' }])
  expect(openJournal).toHaveBeenCalledOnce()
})
