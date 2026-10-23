import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionTurnActivity } from '../../shared/agent-session-wire'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

type Row = { key: string; body: AgentJournalItemBody }

function harness() {
  const rows: Row[] = []
  const activities: (AgentSessionTurnActivity | null)[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => {},
    publish: () => {},
    setActivity: (activity) => activities.push(activity)
  }
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => THREAD_ID,
    schedule: (run: () => void) => {
      run()
      return () => {}
    }
  })
  return { translator, rows, activities }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

function subagentItem(kind: string, agentThreadId: string, agentPath: string): unknown {
  return {
    turnId: TURN_ID,
    item: {
      type: 'subAgentActivity',
      id: `item-${agentThreadId}-${kind}`,
      kind,
      agentThreadId,
      agentPath
    }
  }
}

/** Every activity item reaches the wire twice. */
function deliverActivity(
  translator: ReturnType<typeof createCodexJournalTranslator>,
  params: unknown
): void {
  const item = (params as { item: { kind: string; agentThreadId: string } }).item
  if (item.kind === 'started' || item.kind === 'completed') {
    translator.handle({
      type: 'notification',
      sessionId: SESSION_ID,
      threadId: item.agentThreadId,
      method: item.kind === 'started' ? 'turn/started' : 'turn/completed',
      params: {
        threadId: item.agentThreadId,
        turn: {
          id: `execution:${item.agentThreadId}`,
          status: item.kind === 'started' ? 'inProgress' : 'completed'
        }
      }
    })
  }
  translator.handle(notification('item/started', params))
  translator.handle(notification('item/completed', params))
}

describe('codex journal translation — subagents', () => {
  it('writes neither a subagent row nor an opcode-shaped one: the host saves each child', () => {
    const { translator, rows } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/list_directory'))
    deliverActivity(translator, subagentItem('interacted', 'child-1', '/root/list_directory'))

    // Four wire deliveries (two items, each sent twice), and none of the gray
    // `codex · item:subAgentActivity` rows survive.
    const providerFrameKinds = rows.flatMap((row) =>
      row.body.kind === 'status' && row.body.providerFrame ? [row.body.providerFrame.kind] : []
    )
    expect(providerFrameKinds).toEqual([])
    expect(rows.filter((row) => row.key.includes('subagent'))).toEqual([])
  })

  // The translator claims the item, but claiming it must not take the turn tail with
  // it: the activity table is reached only through the publish arm, so a bare
  // return leaves the tail stuck on whatever the previous frame said.
  it('still publishes the turn tail for an item it claims', () => {
    const { translator, activities } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    activities.length = 0
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/read'))

    expect(activities.at(-1)).toEqual({
      turnId: TURN_ID,
      text: 'Coordinating with another agent'
    })
  })
})
