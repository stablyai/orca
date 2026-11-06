import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  return { sink, items }
}

function providerFrameKinds(items: { body: AgentJournalItemBody }[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame.kind] : []
  )
}

/** Shape reported from Claude Code 2.1.316; UUIDs are test identities. */
function pluginUi(subtype: string | undefined, uuid: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'system',
      subtype,
      plugin: 'fos-skills',
      ...fields,
      uuid,
      session_id: 'claude-session'
    }
  }
}

function userTurn(uuid: string, text: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    startsTurn: true as const,
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: text }
    }
  }
}

function assistantReply(uuid: string, text: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'assistant',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    }
  }
}

describe('Claude plugin UI frames', () => {
  it('keeps plugin status lines and toasts off the transcript for a whole turn', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 'Reply with exactly PROBE_OK and nothing else.'))
    translator.handle(pluginUi('ui_status', 'ui-1', { text: 'PR 6 · 진행 13 · 대기 6   /board' }))
    translator.handle(assistantReply('assistant-1', 'PROBE_OK'))
    // Captured from Claude Code 2.1.316 with an isolated test plugin.
    translator.handle(
      pluginUi('ui_toast', 'ui-2', {
        plugin: 'qa-plugin-ui',
        text: 'QA plugin toast: prompt seen',
        timeout_ms: 4000
      })
    )
    translator.handle(pluginUi('ui_status', 'ui-3', { text: null }))
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'result',
        subtype: 'success',
        uuid: 'result-1',
        session_id: 'claude-session',
        is_error: false,
        result: 'PROBE_OK',
        terminal_reason: 'completed'
      }
    })

    expect(providerFrameKinds(state.items)).toEqual([])
    expect(
      state.items.flatMap((item) =>
        item.body.kind === 'message' && item.body.role === 'assistant' ? [item.body.blocks] : []
      )
    ).toEqual([[{ type: 'text', text: 'PROBE_OK' }]])
  })

  it('keeps the other plugin UI subtypes off the transcript too', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    for (const [index, subtype] of [
      'ui_invalidate',
      'ui_log',
      'ui_panes',
      'ui_placed',
      'ui_scroll',
      'ui_focus',
      'ui_future',
      'future_notice'
    ].entries()) {
      translator.handle(pluginUi(subtype, `ui-${index}`, {}))
    }

    translator.handle(
      pluginUi('ui_panes', 'historical-focus', {
        panes: [{ id: 'blast-radius', plugin: 'blast-radius' }],
        focus_requested_id: 'blast-radius'
      })
    )
    expect(providerFrameKinds(state.items)).toEqual([])
  })

  it.each(['ui_status', 'future_notice', undefined])(
    'does not flush streamed text for N or 10N %s diagnostics',
    (subtype) => {
      const writes = (count: number) => {
        const state = sinkState()
        const translator = createClaudeJournalTranslator({
          sink: state.sink,
          schedule: () => () => {}
        })
        translator.handle(userTurn('user-stream', 'Reply'))
        let sequence = 0
        const stream = (event: Record<string, unknown>) =>
          translator.handle({
            type: 'message',
            sessionId: 'orca-session',
            message: {
              type: 'stream_event',
              uuid: `stream-${sequence++}`,
              session_id: 'claude-session',
              event
            }
          })
        stream({
          type: 'message_start',
          message: { id: 'msg-stream', role: 'assistant', content: [] }
        })
        stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (let i = 0; i < count; i++) {
          stream({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'a' }
          })
          const frame = pluginUi(subtype, `status-${i}`, {
            text: 'PR 6 · 진행 13 · 대기 6   /board'
          })
          translator.handle(frame)
        }
        const assistantWrites = () =>
          state.items.filter(({ body }) => body.kind === 'message' && body.role === 'assistant')
        expect(assistantWrites()).toHaveLength(0)
        expect(providerFrameKinds(state.items)).toEqual([])
        translator.flush()
        expect(assistantWrites()).toHaveLength(1)
        expect(assistantWrites()[0].body).toMatchObject({
          blocks: [{ type: 'text', text: 'a'.repeat(count) }]
        })
        translator.dispose()
        return assistantWrites().length
      }
      expect(writes(20)).toBe(writes(200))
    }
  )
})
