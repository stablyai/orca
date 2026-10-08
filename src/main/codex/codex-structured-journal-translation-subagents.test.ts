import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionTurnActivity } from '../../shared/agent-session-wire'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
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

function rosterAgents(rows: Row[]): { id: string; state: string; tokens?: number }[] {
  const body = rows.findLast((row) => row.key.startsWith('orca:codex-subagents'))?.body
  if (!body || body.kind !== 'message') {
    return []
  }
  return body.blocks.find(isSubagentGroupBlock)?.agents ?? []
}

describe('codex journal translation — subagents', () => {
  it('renders a spawn group as one roster row and no opcode-shaped duplicate', () => {
    const { translator, rows } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/list_directory'))
    deliverActivity(translator, subagentItem('interacted', 'child-1', '/root/list_directory'))

    expect(rosterAgents(rows)).toMatchObject([
      { id: 'child-1', label: 'list_directory', state: 'working' }
    ])
    // Four wire deliveries (two items, each sent twice) collapse to ONE roster
    // row, and none of the gray `codex · item:subAgentActivity` rows survive.
    const providerFrameKinds = rows.flatMap((row) =>
      row.body.kind === 'status' && row.body.providerFrame ? [row.body.providerFrame.kind] : []
    )
    expect(providerFrameKinds).toEqual([])
    expect(rows.filter((row) => row.key.startsWith('orca:codex-subagents'))).toHaveLength(1)
  })

  // The roster claims the item, but claiming it must not take the turn tail with
  // it: the activity table is reached only through the publish arm, so a bare
  // return leaves the tail stuck on whatever the previous frame said.
  it('still publishes the turn tail for an item the roster claims', () => {
    const { translator, activities } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    activities.length = 0
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/read'))

    expect(activities.at(-1)).toEqual({
      turnId: TURN_ID,
      text: 'Coordinating with another agent'
    })
  })

  it('consumes thread/tokenUsage/updated instead of swallowing it as chrome', () => {
    const { translator, rows } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/read'))
    translator.handle(
      notification('thread/tokenUsage/updated', {
        threadId: 'child-1',
        tokenUsage: { total: { totalTokens: 40661 } }
      })
    )

    expect(rosterAgents(rows)).toMatchObject([{ id: 'child-1', tokens: 40661 }])
  })

  // The QA scenario this row got wrong: three `spawn_agent` children were still
  // running when a mid-turn correction ended their turn and opened a new one.
  // They reported `completed` 57-87s later, so a turn boundary is a fact about
  // the turn and never evidence that contact with a child was lost.
  it('leaves children working when their turn ends and a newer turn opens', () => {
    const { translator, rows } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/read_readme'))
    deliverActivity(translator, subagentItem('started', 'child-2', '/root/read_package'))
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
    translator.handle(notification('turn/started', { turn: { id: 'turn-2' } }))

    expect(rosterAgents(rows)).toMatchObject([
      { id: 'child-1', state: 'working' },
      { id: 'child-2', state: 'working' }
    ])

    // And the verdict a child reports after its turn ended still lands on the row.
    deliverActivity(translator, subagentItem('completed', 'child-1', '/root/read_readme'))

    expect(rosterAgents(rows)).toMatchObject([
      { id: 'child-1', state: 'completed' },
      { id: 'child-2', state: 'working' }
    ])
  })

  it('sweeps every group when the provider ends', () => {
    const { translator, rows } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/read'))
    translator.handle({
      type: 'ended',
      sessionId: SESSION_ID,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: 1,
      acquisitionGeneration: 'gen-1'
    } as CodexStructuredSessionEvent)

    expect(rosterAgents(rows)).toMatchObject([{ id: 'child-1', state: 'unverifiable' }])
  })
})
