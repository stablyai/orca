import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import advisorCapture from '../../../../shared/__fixtures__/claude-server-tools-2.1.318.json'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  return {
    items,
    sink: {
      appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        items.push({ identity, body })
      },
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
  }
}
function message(type: 'assistant' | 'user', uuid: string, content: unknown[]) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: type, content }
    }
  }
}

describe('Claude server tool translation', () => {
  // Claude Code 2.1.318 stream-json; identities normalized and encrypted bytes redacted.
  it('completes the captured server tool on its original card without unsupported content', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const handle = (frame: unknown) =>
      translator.handle({
        type: 'message',
        sessionId: 'orca-session',
        message: frame
      })
    handle(advisorCapture[0])
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'tool-call',
      name: 'advisor',
      callId: 'recorded-id-2',
      state: 'running'
    })
    const identity = state.items.at(-1)?.identity
    handle(advisorCapture[1])
    expect(state.items.at(-1)).toMatchObject({
      identity,
      body: {
        kind: 'tool-call',
        name: 'advisor',
        callId: 'recorded-id-2',
        state: 'completed',
        output: {
          head: '{"type":"advisor_redacted_result","encrypted_content":"redacted-advisor-content"}'
        }
      }
    })
    expect(state.items.filter(({ body }) => body.kind === 'status')).toEqual([])
    translator.dispose()
  })

  // Synthetic SDK-shaped contracts cover result roles, typed errors and future tool families.
  it.each(['assistant', 'user'] as const)(
    'pairs identity-shaped results in %s envelopes',
    (role) => {
      const state = sinkState()
      const translator = createClaudeJournalTranslator({ sink: state.sink })
      const call = { type: 'future_call', id: 'server-1', name: 'server_tool', input: {} }
      const result = {
        type: 'future_result',
        tool_use_id: 'server-1',
        content: [
          { type: 'text', text: 'first' },
          { type: 'search_hit', title: 'second' },
          { content: 'third' }
        ]
      }
      translator.handle(
        message('assistant', 'server-call', role === 'assistant' ? [call, result] : [call])
      )
      if (role === 'user') {
        translator.handle(message(role, 'server-result', [result]))
      }
      expect(state.items.at(-1)?.body).toMatchObject({
        kind: 'tool-call',
        name: 'server_tool',
        state: 'completed',
        output: { head: 'first\n{"type":"search_hit","title":"second"}\nthird' }
      })
      translator.handle(
        message(role, 'server-error', [
          {
            type: 'advisor_tool_result',
            tool_use_id: 'server-1',
            content: { type: 'advisor_tool_result_error', error_code: 'unavailable' }
          }
        ])
      )
      expect(state.items.at(-1)?.body).toMatchObject({ kind: 'tool-call', state: 'failed' })
      expect(state.items.filter(({ body }) => body.kind === 'status')).toEqual([])
      expect(state.items.filter(({ body }) => body.kind === 'message')).toEqual([])
      translator.dispose()
    }
  )
})
