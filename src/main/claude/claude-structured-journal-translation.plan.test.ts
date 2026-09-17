import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  return { sink, items }
}

function assistantMessage(uuid: string, content: unknown[]) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'assistant' as const,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'assistant', content }
    }
  }
}

// A proposed plan reaches us two ways: the permission callback, and the
// assistant tool-use stream. Neither can be assumed to fire on its own, so the
// stream ingress is pinned separately from the approval path.
describe('Claude journal translation, plan ingress', () => {
  it('keeps an assistant ExitPlanMode tool use independently journalled', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      assistantMessage('assistant-plan', [
        {
          type: 'tool_use',
          id: 'tool-plan-stream',
          name: 'ExitPlanMode',
          input: { plan: '# Streamed plan\n\n- Keep this ingress' }
        }
      ])
    )

    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'tool-call',
      name: 'ExitPlanMode',
      callId: 'tool-plan-stream',
      input: { plan: '# Streamed plan\n\n- Keep this ingress' }
    })
  })
})
