import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
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
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => {},
    publish: () => {}
  }
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => THREAD_ID,
    schedule: (run: () => void) => {
      run()
      return () => {}
    }
  })
  return { translator, rows }
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

  it('sweeps a child that never reported completion when the turn ends', () => {
    const { translator, rows } = harness()

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    deliverActivity(translator, subagentItem('started', 'child-1', '/root/read'))
    deliverActivity(translator, subagentItem('completed', 'child-2', '/root/search'))
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    expect(rosterAgents(rows)).toMatchObject([
      { id: 'child-1', state: 'unverifiable' },
      { id: 'child-2', state: 'completed' }
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
