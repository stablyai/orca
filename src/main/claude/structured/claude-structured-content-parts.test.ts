import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './journal/claude-structured-journal-translation'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  return { sink, items }
}

function userMessageWith(part: unknown) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    startsTurn: true as const,
    message: {
      type: 'user',
      uuid: 'user-1',
      session_id: 'claude-session',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, part] }
    }
  }
}

/** Local-image replay shape emitted by claudeDispatchMessageContent. */

describe('Claude message content parts', () => {
  it.each(['isMeta', 'isSynthetic', 'isCompactSummary'])(
    'consumes %s skill context without a user bubble, fallback, or new turn',
    (flag) => {
      const state = sinkState()
      const translator = createClaudeJournalTranslator({ sink: state.sink })
      const event = userMessageWith({ type: 'text', text: '# Skill instructions' })
      translator.handle({ ...event, message: { ...event.message, [flag]: true } })
      expect(state.items).toEqual([])
      expect(state.sink.publish).not.toHaveBeenCalled()
    }
  )

  it('keeps tool results in an injected skill message', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const event = userMessageWith({
      type: 'tool_result',
      tool_use_id: 'skill-call',
      content: 'Skill loaded'
    })
    translator.handle({ ...event, message: { ...event.message, isMeta: true } })
    expect(state.items.map((item) => item.body)).toEqual([
      expect.objectContaining({
        kind: 'tool-call',
        state: 'completed',
        output: expect.objectContaining({ head: 'Skill loaded', truncated: false })
      })
    ])
  })

  it('does not render user echoes even without metadata flags', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    for (const content of ['/example-skill', '# Skill instructions']) {
      const event = userMessageWith(null)
      translator.handle({
        ...event,
        message: { ...event.message, message: { role: 'user', content } }
      })
    }
    expect(state.items.flatMap(({ body }) => (body.kind === 'message' ? body.blocks : []))).toEqual(
      []
    )
  })

  it('silently consumes unmarked user context with unknown content parts', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const event = userMessageWith({ type: 'future_context', text: 'Expanded instructions' })
    translator.handle({ ...event, startsTurn: undefined })
    expect(state.items).toEqual([])
    expect(state.sink.publish).not.toHaveBeenCalled()
  })
})
