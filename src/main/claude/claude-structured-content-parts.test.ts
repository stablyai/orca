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
  it('does not leak a wire kind for a locally attached image', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userMessageWith(BASE64_IMAGE))

    expect(providerRows(state.items)).toEqual([])
  })

  it('still renders an image the CLI sends by url', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      userMessageWith({ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } })
    )

    expect(providerRows(state.items)).toEqual([])
    expect(
      state.items.flatMap((item) => (item.body.kind === 'message' ? item.body.blocks : []))
    ).toContainEqual({ type: 'image-ref', url: 'https://x.test/a.png' })
  })

  it('says what is true for a content part it cannot render, not the wire kind', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userMessageWith({ type: 'some_future_part', payload: { a: 1 } }))

    const rows = providerRows(state.items)
    expect(rows).toHaveLength(1)
    // The kind stays on the row for debugging, behind the disclosure.
    expect(rows[0].kind).toBe('message:user:content:some_future_part')
    // ...but the visible text is a sentence, not the opcode.
    expect(rows[0].text).not.toContain('message:user:content')
    expect(rows[0].text.toLowerCase()).toContain('claude')
  })

  it('prefers a readable sentence the part carries over the placeholder', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(
      userMessageWith({ type: 'some_future_part', message: 'the server refused the upload' })
    )

    expect(providerRows(state.items)[0].text).toBe('the server refused the upload')
  })
})
