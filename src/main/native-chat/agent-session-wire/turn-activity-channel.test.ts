import { describe, expect, it } from 'vitest'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import {
  nativeChatReasoningGate,
  nativeChatReasoningGateKey
} from '../../../shared/native-chat-reasoning-row'
import type { AgentSessionTurnActivity as LiveActivity } from '../../../shared/agent-session-turn-activity'
import { createTurnActivityChannel, MAX_OPEN_REASONING_SUBAGENTS } from './turn-activity-channel'

/** The host's live reasoning gate, as a client reads it. */
const reasoningOpen = (
  activity: LiveActivity | null | undefined,
  liveTurnId: string | null,
  agentId?: string
): boolean => nativeChatReasoningGate(nativeChatReasoningGateKey(activity, liveTurnId))(agentId)

function channel() {
  const sent: (AgentSessionTurnActivity | null)[] = []
  return { sent, activity: createTurnActivityChannel({ setActivity: (next) => sent.push(next) }) }
}

const OPEN = { session: true, subagents: [] }
const CLOSED = { session: false, subagents: [] }

describe('the live turn activity channel', () => {
  it('composes the words and the open reasoning, neither clearing the other', () => {
    const { sent, activity } = channel()
    activity.setReasoning('turn-1', OPEN)
    activity.setText('turn-1', 'Thinking through the request')
    activity.setText('turn-1', null)
    activity.setReasoning('turn-1', CLOSED)
    expect(sent).toEqual([
      { turnId: 'turn-1', text: '', reasoning: OPEN },
      { turnId: 'turn-1', text: 'Thinking through the request', reasoning: OPEN },
      { turnId: 'turn-1', text: '', reasoning: OPEN },
      null
    ])
  })

  it('sends words alone exactly as before when nothing is reasoning', () => {
    const { sent, activity } = channel()
    activity.setText('turn-1', 'Running a command')
    activity.setReasoning('turn-1', CLOSED)
    expect(sent).toEqual([{ turnId: 'turn-1', text: 'Running a command' }])
  })

  it('publishes nothing when nothing changed, but always sends a clear', () => {
    const { sent, activity } = channel()
    activity.setReasoning('turn-1', OPEN)
    activity.setReasoning('turn-1', { session: true, subagents: [] })
    activity.setText('turn-1', undefined)
    expect(sent).toHaveLength(1)
    activity.clear()
    activity.clear()
    expect(sent).toEqual([{ turnId: 'turn-1', text: '', reasoning: OPEN }, null, null])
  })

  it("drops the previous turn's words when a new turn reports", () => {
    const { sent, activity } = channel()
    activity.setText('turn-1', 'Editing files')
    activity.setReasoning('turn-2', OPEN)
    expect(sent.at(-1)).toEqual({ turnId: 'turn-2', text: '', reasoning: OPEN })
    activity.setReasoning(null, OPEN)
    expect(sent.at(-1)).toBeNull()
  })

  it("publishes one event's updates once, as their net result", () => {
    const { sent, activity } = channel()
    activity.setText('turn-1', 'Thinking through the request')
    activity.setReasoning('turn-1', OPEN)
    sent.length = 0
    activity.batch(() => {
      activity.setText('turn-1', null)
      activity.setReasoning('turn-1', CLOSED)
    })
    expect(sent).toEqual([null])
    activity.batch(() => {
      activity.clear()
      activity.setReasoning('turn-2', OPEN)
    })
    expect(sent).toEqual([null, { turnId: 'turn-2', text: '', reasoning: OPEN }])
    activity.batch(() => {})
    expect(sent).toHaveLength(2)
  })

  it("reaches a caught-up client's state through every change of who is reasoning", () => {
    const page = {
      sessionId: 's',
      epoch: 'e',
      direction: 'tail' as const,
      items: [],
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'e', sequence: 1 },
        newest: { epoch: 'e', sequence: 1 },
        nextCursor: { epoch: 'e', sequence: 2 }
      },
      liveCursor: { epoch: 'e', sequence: 1 },
      hasOlder: false,
      hasNewer: false
    }
    let state: StructuredAgentSessionState = reduceStructuredAgentSession(
      EMPTY_STRUCTURED_AGENT_SESSION,
      { type: 'event', event: { type: 'snapshot', sessionId: 's', fence: 1, page } }
    )
    const activity = createTurnActivityChannel({
      setActivity: (next) => {
        state = reduceStructuredAgentSession(state, {
          type: 'event',
          event: {
            type: 'batch',
            sessionId: 's',
            batch: { cursor: state.cursor!, items: [], removedItemIds: [], submissions: [] },
            activity: next
          }
        })
      }
    })
    const seen = () => [
      reasoningOpen(state.activity, 'turn-1'),
      reasoningOpen(state.activity, 'turn-1', 'agent-a')
    ]
    activity.setReasoning('turn-1', OPEN)
    expect(seen()).toEqual([true, false])
    activity.setReasoning('turn-1', { session: true, subagents: ['agent-a'] })
    expect(seen()).toEqual([true, true])
    activity.setReasoning('turn-1', { session: false, subagents: ['agent-a'] })
    expect(seen()).toEqual([false, true])
    activity.setReasoning('turn-1', CLOSED)
    expect(seen()).toEqual([false, false])
    activity.setText('turn-1', 'Running a command')
    activity.setReasoning('turn-1', { session: false, subagents: ['agent-a'] })
    expect(seen()).toEqual([false, true])
    activity.setReasoning('turn-1', CLOSED)
    expect(seen()).toEqual([false, false])
    expect(state.activity?.text).toBe('Running a command')
  })

  it('names each subagent once, in a stable order, and boundedly', () => {
    const { sent, activity } = channel()
    activity.setReasoning('turn-1', { session: false, subagents: ['b', 'a', 'b'] })
    activity.setReasoning('turn-1', { session: false, subagents: ['a', 'b'] })
    expect(sent).toEqual([
      { turnId: 'turn-1', text: '', reasoning: { session: false, subagents: ['a', 'b'] } }
    ])
    const many = Array.from({ length: MAX_OPEN_REASONING_SUBAGENTS + 8 }, (_, i) => `agent-${i}`)
    activity.setReasoning('turn-1', { session: false, subagents: many })
    expect(sent.at(-1)?.reasoning?.subagents).toHaveLength(MAX_OPEN_REASONING_SUBAGENTS)
  })
})
