import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn()
  }
  return { sink, items, tombstones }
}

function message(type: 'assistant' | 'user', uuid: string, content: unknown[]) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(type === 'user' ? { startsTurn: true as const } : {}),
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: type, content }
    }
  }
}

function providerFrameKinds(items: { body: AgentJournalItemBody }[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame.kind] : []
  )
}

const ADVISOR_TOOL_KEY = 'orca:claude-tool%3Aclaude-session%3Asrvtoolu-1'

describe('Claude structured journal translation of server tools', () => {
  it('journals a server tool call and its result as one completed tool row', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(message('user', 'user-1', [{ type: 'text', text: 'Review my plan' }]))
    translator.handle(
      message('assistant', 'assistant-advisor', [
        { type: 'server_tool_use', id: 'srvtoolu-1', name: 'advisor', input: {} },
        {
          type: 'advisor_tool_result',
          tool_use_id: 'srvtoolu-1',
          content: [{ type: 'text', text: 'Looks good' }]
        }
      ])
    )

    const keyed = new Map(
      state.items.map((item) => [agentJournalItemKey(item.identity), item.body])
    )
    expect(keyed.get(ADVISOR_TOOL_KEY)).toMatchObject({
      kind: 'tool-call',
      name: 'advisor',
      callId: 'srvtoolu-1',
      state: 'completed',
      output: { head: 'Looks good', truncated: false }
    })
    expect(providerFrameKinds(state.items)).toEqual([])
  })

  it('shows a server tool call as running until its result arrives', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(message('user', 'user-1', [{ type: 'text', text: 'Review my plan' }]))
    translator.handle(
      message('assistant', 'assistant-advisor', [
        { type: 'server_tool_use', id: 'srvtoolu-1', name: 'advisor', input: {} }
      ])
    )

    const keyed = new Map(
      state.items.map((item) => [agentJournalItemKey(item.identity), item.body])
    )
    expect(keyed.get(ADVISOR_TOOL_KEY)).toMatchObject({
      kind: 'tool-call',
      name: 'advisor',
      callId: 'srvtoolu-1',
      state: 'running'
    })
    expect(providerFrameKinds(state.items)).toEqual([])
  })
})
