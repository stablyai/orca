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

function providerRows(items: { body: AgentJournalItemBody }[]) {
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.providerFrame
      ? [{ kind: item.body.providerFrame.kind, text: item.body.text }]
      : []
  )
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

/** Exactly what claudeDispatchMessageContent sends for a local attachment. */
const BASE64_IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }
}

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

  it.each([
    { content: '# Skill instructions' },
    { content: [{ type: 'future_context', text: '# Skill instructions' }] },
    {
      content: [
        { type: 'text', text: '[Image: source: /tmp/pasted.png]' },
        { type: 'text', text: '# Skill instructions' }
      ]
    }
  ])('does not surface injected content as text or a provider fallback: %j', ({ content }) => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const event = userMessageWith(null)
    translator.handle({
      ...event,
      message: { ...event.message, isMeta: true, message: { role: 'user', content } }
    })
    expect(state.items).toEqual([])
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

  it('does not render injected image companions or start a turn', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const event = userMessageWith(null)
    const content = [{ type: 'text', text: '[Image: source: /tmp/pasted.png]' }]
    translator.handle({
      ...event,
      message: { ...event.message, isMeta: true, message: { role: 'user', content } }
    })
    expect(state.items).toEqual([])
  })

  it('does not leak a wire kind for a locally attached image', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userMessageWith(BASE64_IMAGE))

    expect(providerRows(state.items)).toEqual([])
  })

  it('does not render echoed image URLs', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      userMessageWith({ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } })
    )

    expect(providerRows(state.items)).toEqual([])
    expect(
      state.items.flatMap((item) => (item.body.kind === 'message' ? item.body.blocks : []))
    ).toEqual([])
  })

  it('says what is true for a content part it cannot render, not the wire kind', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    const event = userMessageWith(null)
    translator.handle({
      ...event,
      message: {
        ...event.message,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'some_future_part', payload: { a: 1 } }] }
      }
    })

    const rows = providerRows(state.items)
    expect(rows).toHaveLength(1)
    // The kind stays on the row for debugging, behind the disclosure.
    expect(rows[0].kind).toBe('message:assistant:content:some_future_part')
    // ...but the visible text is a sentence, not the opcode.
    expect(rows[0].text).not.toContain('message:assistant:content')
    expect(rows[0].text.toLowerCase()).toContain('claude')
  })

  it('prefers a readable sentence the part carries over the placeholder', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    const event = userMessageWith(null)
    translator.handle({
      ...event,
      message: {
        ...event.message,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'some_future_part', message: 'the server refused the upload' }]
        }
      }
    })

    expect(providerRows(state.items)[0].text).toBe('the server refused the upload')
  })
})
