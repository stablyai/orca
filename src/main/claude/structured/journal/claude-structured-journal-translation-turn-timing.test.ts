import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from '../claude-structured-session-state'

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

function userTurn(uuid: string, observedAt?: number): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    startsTurn: true,
    ...(observedAt === undefined ? {} : { observedAt }),
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
    }
  }
}

const USER_1_KEY = 'claude:claude-session:user-1'

function sessionState(
  state: 'idle' | 'running' | 'requires_action',
  observedAt: number
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    observedAt,
    message: {
      type: 'system',
      subtype: 'session_state_changed',
      state,
      uuid: `ssc-${state}`,
      session_id: 'claude-session'
    }
  }
}

describe('the CLI session state ends a turn no result settled', () => {
  it('settles the open turn on idle, with no verdict it was not given', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 1_000))
    expect(state.lifecycle().at(-1)?.state).toBe('running')

    translator.handle(sessionState('idle', 5_000))

    expect(state.lifecycle().at(-1)).toMatchObject({
      turnId: 'user-1',
      state: 'completed',
      completedAt: 5_000
    })
    expect(state.lifecycle().at(-1)?.outcome).toBeUndefined()
  })
})

describe('Claude structured turn timing', () => {
  afterEach(() => {
    vi.useRealTimers()
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
        outcome: 'superseded',
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
})
