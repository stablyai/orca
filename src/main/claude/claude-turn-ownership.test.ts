// Which turn a Stop is allowed to interrupt, for turns the provider opened on its
// own as well as turns Orca's own send echo opened.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import {
  CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS,
  cancelClaudeStructuredTurn
} from './claude-structured-prompt-ownership'
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

  it('keeps the prior dispatch fence after an unknown later send', async () => {
    vi.useFakeTimers()
    try {
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

      const cancellation = adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'echo-turn',
        fence: 7
      })
      await vi.advanceTimersByTimeAsync(CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS - 1)
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(cancellation).resolves.toEqual({ cancelled: true })
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a queued-cancel provider release an unresolved ordinary Stop', async () => {
    const claude = fakeClaude({
      replayUuid: 'echo-turn',
      capabilities: ['interrupt_cancel_queued_v1']
    })
    const { adapter, bodies, connection } = await acquiredWithJournal(claude)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(runningTurnId(bodies)).toBe('echo-turn')

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'echo-turn',
        fence: 7,
        dispatchStatus: { state: 'unknown', recovered: false }
      })
    ).resolves.toEqual({ cancelled: true })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  })

  it('lets ordinary Stop proceed after the unresolved delivery fence expires', async () => {
    vi.useFakeTimers()
    try {
      const claude = fakeClaude({ replayUuid: 'echo-turn' })
      const { adapter, bodies, connection } = await acquiredWithJournal(claude)

      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
      expect(runningTurnId(bodies)).toBe('echo-turn')

      const cancellation = adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'echo-turn',
        fence: 7,
        dispatchStatus: { state: 'unknown', recovered: false }
      })
      await vi.advanceTimersByTimeAsync(CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS - 1)
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(cancellation).resolves.toEqual({ cancelled: true })
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases ordinary Stop as soon as a retired delivery fence settles', async () => {
    vi.useFakeTimers()
    try {
      const session = sessionFor()
      session.dispatchSequence = 1
      session.translator = {
        handle: vi.fn(),
        journalPrompts: { cancel: vi.fn(), resolve: vi.fn() },
        currentTurnId: 'turn-1',
        flush: vi.fn(),
        pendingStreamedBlocks: 0,
        dispose: vi.fn()
      }
      session.retiredDispatchWaiters = [
        {
          acceptsResult: false,
          clientMessageId: 'client-2',
          sentUuid: 'uncertain',
          dispatchSequence: 1,
          replayContentKey: 'ship-it',
          resolve: vi.fn(),
          retired: true
        }
      ]
      const interrupt = vi.fn().mockResolvedValue(undefined)
      session.connection.interrupt = interrupt
      const cancellation = cancelClaudeStructuredTurn({
        request: { sessionId: 'session-1', turnId: 'turn-1', fence: 1 },
        sessions: new Map([['session-1', session]]),
        compactions: new StructuredSessionCompaction(),
        admitPromptCancellation: () => true
      })
      await vi.advanceTimersByTimeAsync(100)
      session.retiredDispatchWaiters = []
      await vi.advanceTimersByTimeAsync(100)
      const settledBeforeDeadline = interrupt.mock.calls.length > 0
      if (!settledBeforeDeadline) {
        await vi.advanceTimersByTimeAsync(CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS)
        await cancellation
      }
      expect(settledBeforeDeadline).toBe(true)
      await expect(cancellation).resolves.toEqual({ cancelled: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait when the dispatch admission is already current', async () => {
    vi.useFakeTimers()
    try {
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors an unresolved journal submission before the first in-memory dispatch', async () => {
    vi.useFakeTimers()
    try {
      const claude = fakeClaude({ replayUuid: null })
      const { adapter, bodies, connection } = await acquiredWithJournal(claude)
      providerOutput(connection, 'provider-turn')
      expect(runningTurnId(bodies)).toBe('provider-turn')

      const cancellation = adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'provider-turn',
        fence: 7,
        dispatchStatus: { state: 'pending', recovered: false }
      })
      await vi.advanceTimersByTimeAsync(CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS - 1)
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(cancellation).resolves.toEqual({ cancelled: true })
      expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
