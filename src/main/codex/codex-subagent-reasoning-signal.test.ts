// A Codex helper thread's reasoning, as Codex 0.159 sends it with default features (trimmed from a
// real capture, ids shortened): the parent names the child only through subAgentActivity, the child
// thread runs its own turn and reasoning item, and no thread/started precedes it.
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../shared/agent-session-wire'
import {
  nativeChatReasoningGate,
  nativeChatReasoningGateKey
} from '../../shared/native-chat-reasoning-row'
import type { AgentSessionTurnActivity as LiveActivity } from '../../shared/agent-session-turn-activity'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

/** The host's live reasoning gate, as a client reads it. */
const reasoningOpen = (
  activity: LiveActivity | null | undefined,
  liveTurnId: string | null,
  agentId?: string
): boolean => nativeChatReasoningGate(nativeChatReasoningGateKey(activity, liveTurnId))(agentId)

const PARENT = '00000000-0000-4000-8000-000000000001'
const CHILD = '00000000-0000-4000-8000-000000000002'
const PARENT_TURN = 'turn-parent-611f79'
const CHILD_TURN = 'turn-child-4ef1602c'

function on(threadId: string, method: string, params: Record<string, unknown>) {
  return {
    type: 'notification',
    sessionId: 'session-1',
    threadId,
    method,
    params: { threadId, ...params }
  } satisfies CodexStructuredSessionEvent
}

const spawned = {
  type: 'subAgentActivity',
  id: 'call_r0m2v9O1',
  kind: 'started',
  agentThreadId: CHILD,
  agentPath: '/root/counting_retry'
}
const finished = { ...spawned, id: `subagent-completed-${CHILD_TURN}`, kind: 'completed' }
const childReasoning = { type: 'reasoning', id: 'rs_96fe2a82', summary: [], content: [] }

function replay() {
  const activities: (AgentSessionTurnActivity | null)[] = []
  const rosters: AgentJournalItemBody[] = []
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (_identity, body) => {
        if (body.kind === 'message' && body.blocks.some((b) => b.type === 'subagent-group')) {
          rosters.push(body)
        }
      },
      appendTombstone: () => {},
      publish: () => {},
      setActivity: (activity) => activities.push(activity)
    },
    sessionId: 'session-1',
    primaryThreadId: () => PARENT,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const step = (event: CodexStructuredSessionEvent) => {
    translator.handle(event)
    return activities.at(-1) ?? null
  }
  return { step, rosters }
}

/** The roster's entry for the child, as the parent's surfaces draw it. */
function childEntry(rosters: AgentJournalItemBody[]) {
  const body = rosters.at(-1)
  const group =
    body?.kind === 'message' ? body.blocks.find((b) => b.type === 'subagent-group') : undefined
  return group?.type === 'subagent-group' ? group.agents.find((a) => a.id === CHILD) : undefined
}

describe("a Codex helper thread's reasoning (captured, Codex 0.159)", () => {
  it("reports it as the child's over exactly its span, never as the parent's", () => {
    const { step, rosters } = replay()
    step(on(PARENT, 'turn/started', { turn: { id: PARENT_TURN, status: 'inProgress' } }))
    step(on(PARENT, 'item/started', { turnId: PARENT_TURN, item: spawned }))
    step(on(PARENT, 'item/completed', { turnId: PARENT_TURN, item: spawned }))
    step(on(CHILD, 'turn/started', { turn: { id: CHILD_TURN, status: 'inProgress' } }))
    expect(childEntry(rosters)?.state).toBe('working')

    const open = step(on(CHILD, 'item/started', { turnId: CHILD_TURN, item: childReasoning }))
    expect(open?.reasoning).toEqual({ session: false, subagents: [CHILD] })
    expect(reasoningOpen(open, PARENT_TURN)).toBe(false)
    expect(reasoningOpen(open, PARENT_TURN, CHILD)).toBe(true)

    const closed = step(on(CHILD, 'item/completed', { turnId: CHILD_TURN, item: childReasoning }))
    expect(closed?.reasoning).toBeUndefined()
    expect(closed?.text).toBe('Coordinating with another agent')
  })

  it("leaves the parent's turn and line alone when the child's turn completes", () => {
    const { step, rosters } = replay()
    step(on(PARENT, 'turn/started', { turn: { id: PARENT_TURN, status: 'inProgress' } }))
    step(on(PARENT, 'item/started', { turnId: PARENT_TURN, item: spawned }))
    step(on(PARENT, 'item/completed', { turnId: PARENT_TURN, item: spawned }))
    step(on(CHILD, 'turn/started', { turn: { id: CHILD_TURN, status: 'inProgress' } }))
    step(on(CHILD, 'item/started', { turnId: CHILD_TURN, item: childReasoning }))
    step(on(CHILD, 'item/completed', { turnId: CHILD_TURN, item: childReasoning }))
    const before = step(on(PARENT, 'item/started', { turnId: PARENT_TURN, item: finished }))
    step(on(PARENT, 'item/completed', { turnId: PARENT_TURN, item: finished }))
    const after = step(
      on(CHILD, 'turn/completed', { turn: { id: CHILD_TURN, status: 'completed' } })
    )
    expect(after).toEqual(before)
    expect(after).toEqual({ turnId: PARENT_TURN, text: 'Coordinating with another agent' })
    expect(childEntry(rosters)?.state).toBe('completed')
  })
})
