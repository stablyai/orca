import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { acquired, fakeClaude } from './claude-structured-session-test-support'

type Append = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: StructuredAgentSessionAppendOptions | undefined
}

function sinkState() {
  const items: Append[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => items.push({ identity, body, options }),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn()
  }
  const lifecycle = () =>
    items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [{ ...turn, options: item.options }] : []
    })
  return { sink, items, tombstones, lifecycle }
}

function userTurn(
  uuid: string,
  observedAt?: number,
  requestedAt?: number
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    startsTurn: true,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
    }
  }
}

function result(
  observedAt?: number,
  fields: Record<string, unknown> = {}
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    ...(observedAt === undefined ? {} : { observedAt }),
    message: {
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session',
      is_error: false,
      result: 'done',
      ...fields
    }
  }
}

const USER_1_KEY = 'claude:claude-session:user-1'

describe('Claude structured turn timing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps the running row with the host start time as both startedAt and row ts', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))

    expect(state.lifecycle()).toEqual([
      {
        turnId: 'user-1',
        state: 'running',
        startedAt: 1_000,
        userItemId: USER_1_KEY,
        options: { observedAt: 1_000 }
      }
    ])
  })

  it('keys the running row to the user echo that opened the turn', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))

    // The echo itself is never a row; its provider key is what the submission adopted.
    expect(state.items.some((item) => item.body.kind === 'message')).toBe(false)
    expect(state.lifecycle().at(-1)?.userItemId).toBe(USER_1_KEY)
  })

  it('revises the running row to completed with the result receipt time', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle(result(4_500))

    expect(state.tombstones).toEqual([])
    expect(state.lifecycle().at(-1)).toEqual({
      turnId: 'user-1',
      state: 'completed',
      startedAt: 1_000,
      completedAt: 4_500,
      userItemId: USER_1_KEY,
      options: {}
    })
    expect(state.items.at(-1)?.identity).toEqual(state.items[0]?.identity)
  })

  it('carries the provider-measured duration onto the completed row', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle(result(4_500, { duration_ms: 3_210 }))

    expect(state.lifecycle().at(-1)).toMatchObject({
      state: 'completed',
      durationMs: 3_210,
      userItemId: USER_1_KEY
    })
  })

  it('omits durationMs when the result reports none', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle(result(4_500))

    expect(state.lifecycle().at(-1)).not.toHaveProperty('durationMs')
  })

  it('revises an open turn to interrupted when the session ends without a result', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle({
      type: 'ended',
      sessionId: 'orca-session',
      reason: 'child exited',
      observedAt: 2_250
    })

    expect(state.tombstones).toEqual([])
    expect(state.lifecycle().at(-1)).toMatchObject({
      turnId: 'user-1',
      state: 'interrupted',
      startedAt: 1_000,
      completedAt: 2_250
    })
  })

  it('interrupts the open turn at the receipt time of the turn that replaces it', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle(userTurn('user-2', 3_000))

    expect(state.lifecycle().map(({ options: _options, ...row }) => row)).toEqual([
      { turnId: 'user-1', state: 'running', startedAt: 1_000, userItemId: USER_1_KEY },
      {
        turnId: 'user-1',
        state: 'interrupted',
        startedAt: 1_000,
        completedAt: 3_000,
        userItemId: USER_1_KEY
      },
      {
        turnId: 'user-2',
        state: 'running',
        startedAt: 3_000,
        userItemId: 'claude:claude-session:user-2'
      }
    ])
  })

  it('falls back to the host clock when an event carries no receipt time', () => {
    vi.useFakeTimers({ now: 50_000 })
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1'))
    vi.setSystemTime(56_000)
    translator.handle(result())

    expect(state.lifecycle().at(-1)).toMatchObject({
      state: 'completed',
      startedAt: 50_000,
      completedAt: 56_000
    })
  })

  it('carries the send acceptance instant onto every revision of the turn it opened', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    // Accepted at 1_000, echoed 133s later: the provider held it behind a
    // running turn, and the turn's own work then took 40s.
    translator.handle(userTurn('user-1', 134_000, 1_000))
    translator.handle(result(174_000, { duration_ms: 40_000 }))

    expect(state.lifecycle().map(({ options: _options, ...row }) => row)).toEqual([
      {
        turnId: 'user-1',
        state: 'running',
        requestedAt: 1_000,
        startedAt: 134_000,
        userItemId: USER_1_KEY
      },
      {
        turnId: 'user-1',
        state: 'completed',
        requestedAt: 1_000,
        startedAt: 134_000,
        completedAt: 174_000,
        durationMs: 40_000,
        userItemId: USER_1_KEY
      }
    ])
  })

  it('records no acceptance instant for a turn no submission opened', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle(result(4_500))

    for (const row of state.lifecycle()) {
      expect(row).not.toHaveProperty('requestedAt')
    }
  })

  it('acquisition puts the dispatch acceptance instant on the replay that starts the turn', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const dispatch = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ship it' }] },
      fence: 7,
      requestedAt: 1_700_000_000_000
    })
    await Promise.resolve()
    const connection = claude.connections[0]!
    connection.handlers.onMessage?.({ ...connection.sent[0], uuid: 'turn-1' })
    await dispatch
    connection.handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: connection.sent[0]?.session_id,
      is_error: false,
      result: 'ok'
    })

    const messages = events.filter(
      (event) => event.type === 'message' && event.message.type !== 'system'
    )
    // Only the replay that opens the turn carries it; the result never does.
    expect(messages).toEqual([
      expect.objectContaining({ startsTurn: true, requestedAt: 1_700_000_000_000 }),
      expect.not.objectContaining({ requestedAt: expect.anything() })
    ])
  })

  it('acquisition stamps turn boundaries from the host clock, never the frame timestamp', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const dispatch = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ship it' }] },
      fence: 7
    })
    await Promise.resolve()
    const connection = claude.connections[0]!
    connection.handlers.onMessage?.({
      ...connection.sent[0],
      uuid: 'turn-1',
      timestamp: '2001-01-01T00:00:00.000Z'
    })
    await dispatch
    connection.handlers.onMessage?.({
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: connection.sent[0]?.session_id,
      timestamp: '2001-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
    })
    connection.handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: connection.sent[0]?.session_id,
      timestamp: '2001-01-01T00:00:02.000Z',
      is_error: false,
      result: 'ok'
    })

    const messages = events.filter(
      (event) => event.type === 'message' && event.message.type !== 'system'
    )
    expect(messages).toEqual([
      expect.objectContaining({ startsTurn: true, observedAt: 1_700_000_000_500 }),
      expect.not.objectContaining({ observedAt: expect.anything() }),
      expect.objectContaining({
        message: expect.objectContaining({ type: 'result' }),
        observedAt: 1_700_000_000_500
      })
    ])
  })
})
