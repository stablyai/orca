// Which turn a Stop is allowed to interrupt, for turns the provider opened on its
// own as well as turns Orca's own send echo opened.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { cancelClaudeStructuredTurn } from './claude-structured-prompt-ownership'
import { sessionFor } from './claude-structured-dispatch-test-support'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  adapterFor,
  fakeClaude,
  identityFor,
  type FakeConnection
} from './claude-structured-session-test-support'

function journalSink(): {
  sink: StructuredAgentSessionEventSink
  bodies: Map<string, AgentJournalItemBody>
} {
  const bodies = new Map<string, AgentJournalItemBody>()
  return {
    bodies,
    sink: {
      appendItem: (identity, body) => bodies.set(agentJournalItemKey(identity), body),
      appendTombstone: (identity) => bodies.delete(agentJournalItemKey(identity)),
      publish: vi.fn()
    }
  }
}

/** The turn row a client would read, which is the id its Stop carries. */
function runningTurnId(bodies: Map<string, AgentJournalItemBody>): string | null {
  for (const body of bodies.values()) {
    const turn = readAgentJournalTurn(body)
    if (turn?.state === 'running') {
      return turn.turnId
    }
  }
  return null
}

async function acquiredWithJournal(claude: ReturnType<typeof fakeClaude>): Promise<{
  adapter: ReturnType<typeof adapterFor>
  bodies: Map<string, AgentJournalItemBody>
  connection: FakeConnection
}> {
  const { sink, bodies } = journalSink()
  const adapter = adapterFor(claude)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: sink
  })
  const connection = claude.connections[0]
  if (!connection) {
    throw new Error('expected Claude connection')
  }
  return { adapter, bodies, connection }
}

function completeTurn(connection: FakeConnection, uuid: string): void {
  connection.handlers.onMessage?.({
    type: 'result',
    subtype: 'success',
    uuid,
    session_id: PROVIDER_SESSION_ID,
    is_error: false,
    terminal_reason: 'completed',
    duration_ms: 12
  })
}

/** The provider resuming on its own — a background task reporting in wakes the agent. */
function providerOutput(connection: FakeConnection, uuid: string): void {
  connection.handlers.onMessage?.({
    type: 'assistant',
    uuid,
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'picking this back up' }] }
  })
}

/** A session whose in-memory turn is `turnId`, standing in for the adapter's own read. */
function sessionHoldingTurn(turnId: string | null): ReturnType<typeof sessionFor> {
  const session = sessionFor()
  session.dispatchSequence = 1
  session.translator = {
    handle: vi.fn(),
    openTurnInLiveProviderCycle: false,
    journalPrompts: {
      resolve: vi.fn(),
      handOver: () => () => {},
      cancel: () => ({ accepted: true })
    },
    currentTurnId: turnId,
    commandTurnId: null,
    beginCommand: vi.fn(),
    forgetCommand: vi.fn(),
    commandInterruptRequested: vi.fn(),
    flush: vi.fn(),
    contextActivity: 0,
    markContextActivity: vi.fn(),
    subscribeContextUsageRequests: () => () => {},
    recordContextReport: () => {},
    modelMayHaveChanged: () => {},
    modelWritten: () => {},
    pendingStreamedBlocks: 0,
    dispose: vi.fn()
  }
  return session
}

/** Reads a Stop's outcome without moving the clock, so a Stop held on bookkeeping reads as waiting. */
async function outcomeAtOnce(stop: () => Promise<{ cancelled: boolean }>): Promise<unknown> {
  vi.useFakeTimers()
  try {
    let outcome: unknown = 'still waiting'
    void stop().then((result) => (outcome = result))
    await vi.advanceTimersByTimeAsync(0)
    return outcome
  } finally {
    vi.useRealTimers()
  }
}

function cancellationOf(
  session: ReturnType<typeof sessionFor>,
  request: Parameters<typeof cancelClaudeStructuredTurn>[0]['request']
): Promise<{ cancelled: boolean }> {
  return cancelClaudeStructuredTurn({
    request,
    sessions: new Map([['session-1', session]])
  })
}

describe('Claude turn ownership', () => {
  it('stops a turn the provider opened after the session already dispatched once', async () => {
    const claude = fakeClaude({ replayUuid: 'echo-turn' })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(runningTurnId(bodies)).toBe('echo-turn')
    completeTurn(connection, 'result-1')
    expect(runningTurnId(bodies)).toBeNull()

    providerOutput(connection, 'provider-turn')
    // The client cancels with the journal row's id, which is the provider frame's.
    expect(runningTurnId(bodies)).toBe('provider-turn')

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'provider-turn', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  })

  it('refuses a stale id after the owned turn settles', async () => {
    const claude = fakeClaude({ replayUuid: 'echo-turn' })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(runningTurnId(bodies)).toBe('echo-turn')
    completeTurn(connection, 'result-1')
    expect(runningTurnId(bodies)).toBeNull()

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'echo-turn', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  })

  it('stops the running turn at once while a later send is unresolved', async () => {
    const claude = fakeClaude({ replayUuid: 'echo-turn' })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(runningTurnId(bodies)).toBe('echo-turn')
    const sendFirst = connection.send
    connection.send = async (message) => {
      if (connection.sent.length > 0) {
        throw new Error('input pump stopped')
      }
      await sendFirst(message)
    }

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-2',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'unknown' })

    await expect(
      outcomeAtOnce(() =>
        adapter.cancelTurn({ sessionId: 'session-1', turnId: 'echo-turn', fence: 7 })
      )
    ).resolves.toEqual({ cancelled: true })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  })

  it.each([
    ['with cancel_queued', ['interrupt_cancel_queued_v1']],
    ['without cancel_queued', []]
  ])(
    'stops the running turn at once while its own delivery is unresolved, %s',
    async (_label, capabilities) => {
      const claude = fakeClaude({ replayUuid: 'echo-turn', capabilities })
      const { adapter, bodies, connection } = await acquiredWithJournal(claude)

      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
      expect(runningTurnId(bodies)).toBe('echo-turn')

      await expect(
        outcomeAtOnce(() =>
          adapter.cancelTurn({
            sessionId: 'session-1',
            turnId: 'echo-turn',
            fence: 7,
            dispatchStatus: { state: 'unknown', recovered: false }
          })
        )
      ).resolves.toEqual({ cancelled: true })
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
    }
  )

  it('stops the in-memory turn at once while a retired send is unresolved', async () => {
    const session = sessionHoldingTurn('turn-1')
    session.retiredDispatchWaiters = [
      {
        acceptsResult: false,
        clientMessageId: 'client-2',
        sentUuid: 'uncertain',
        dispatchSequence: 1,
        requestedAt: null,
        replayContentKey: 'ship-it',
        resolve: vi.fn(),
        retired: true
      }
    ]
    const interrupt = vi.fn().mockResolvedValue(undefined)
    session.connection.interrupt = interrupt

    await expect(
      outcomeAtOnce(() =>
        cancellationOf(session, { sessionId: 'session-1', turnId: 'turn-1', fence: 1 })
      )
    ).resolves.toEqual({ cancelled: true })
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it('stops a provider-opened turn at once while the first journal submission is unresolved', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)
    providerOutput(connection, 'provider-turn')
    expect(runningTurnId(bodies)).toBe('provider-turn')

    await expect(
      outcomeAtOnce(() =>
        adapter.cancelTurn({
          sessionId: 'session-1',
          turnId: 'provider-turn',
          fence: 7,
          dispatchStatus: { state: 'pending', recovered: false }
        })
      )
    ).resolves.toEqual({ cancelled: true })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  })

  it('still stops an echo-opened turn', async () => {
    const claude = fakeClaude({ replayUuid: 'echo-turn' })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(runningTurnId(bodies)).toBe('echo-turn')

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'echo-turn', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  })

  // The sink drains asynchronously, so the adapter's own turn can already name a row no client
  // has been shown. The published journal is what a Stop is derived from, so it is what judges it.
  it('admits a Stop for the published turn while the adapter already holds an undrained one', async () => {
    const session = sessionHoldingTurn('turn-undrained')
    const interrupt = vi.fn().mockResolvedValue(undefined)
    session.connection.interrupt = interrupt

    await expect(
      cancellationOf(session, {
        sessionId: 'session-1',
        turnId: 'turn-shown',
        fence: 1,
        resolveLiveTurnId: () => 'turn-shown'
      })
    ).resolves.toEqual({ cancelled: true })
    expect(interrupt).toHaveBeenCalledOnce()
  })

  // The journal drains through a serialized async queue, so a live turn routinely has no published
  // row yet. Refusing there would gate a user's Stop on bookkeeping, so the in-memory turn covers
  // the lag — the journal is authoritative only while it has an answer.
  it('admits a Stop for the live turn while the journal has not drained its row', async () => {
    const session = sessionHoldingTurn('turn-live')
    const interrupt = vi.fn().mockResolvedValue(undefined)
    session.connection.interrupt = interrupt

    await expect(
      cancellationOf(session, {
        sessionId: 'session-1',
        turnId: 'turn-live',
        fence: 1,
        resolveLiveTurnId: () => null
      })
    ).resolves.toEqual({ cancelled: true })
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it('refuses a Stop the adapter still holds once the journal published a newer turn', async () => {
    const session = sessionHoldingTurn('turn-stale')
    const interrupt = vi.fn().mockResolvedValue(undefined)
    session.connection.interrupt = interrupt

    await expect(
      cancellationOf(session, {
        sessionId: 'session-1',
        turnId: 'turn-stale',
        fence: 1,
        resolveLiveTurnId: () => 'turn-newer'
      })
    ).resolves.toEqual({ cancelled: false })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('refuses a Stop for an ended turn at once while a later send is unresolved', async () => {
    const session = sessionHoldingTurn('turn-next')
    const interrupt = vi.fn().mockResolvedValue(undefined)
    session.connection.interrupt = interrupt

    await expect(
      outcomeAtOnce(() =>
        cancellationOf(session, {
          sessionId: 'session-1',
          turnId: 'turn-shown',
          fence: 1,
          dispatchStatus: { state: 'unknown', recovered: false },
          resolveLiveTurnId: () => 'turn-next'
        })
      )
    ).resolves.toEqual({ cancelled: false })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('refuses a stale turn id once the provider opened a newer turn', async () => {
    const claude = fakeClaude({ replayUuid: 'echo-turn' })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    completeTurn(connection, 'result-1')
    providerOutput(connection, 'provider-turn')
    expect(runningTurnId(bodies)).toBe('provider-turn')

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'echo-turn', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'not-a-turn', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  })
})
