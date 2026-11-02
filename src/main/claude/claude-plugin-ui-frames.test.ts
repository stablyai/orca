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

/** Plugin UI frames as Claude Code forwards `$.ui.*` calls in stream-json mode (CLI 2.1.316). */
function pluginUi(subtype: string, uuid: string, fields: Record<string, unknown>) {
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
    translator.handle(pluginUi('ui_status', 'ui-1', { text: 'PR 6 · 13 open   /board' }))
    translator.handle(assistantReply('assistant-1', 'PROBE_OK'))
    translator.handle(pluginUi('ui_toast', 'ui-2', { text: 'Board synced', timeout_ms: 3000 }))
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
      'ui_focus'
    ].entries()) {
      translator.handle(pluginUi(subtype, `ui-${index}`, {}))
    }

    expect(providerFrameKinds(state.items)).toEqual([])
  })
})
