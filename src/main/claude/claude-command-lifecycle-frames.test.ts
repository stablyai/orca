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

function providerFrameKinds(items: { body: AgentJournalItemBody }[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame.kind] : []
  )
}

/**
 * The queue-bookkeeping frame Claude Code 2.1.258 emits for every uuid-stamped
 * command: `command_uuid` plus a state, and no content of its own. Shape and
 * states taken from the CLI's own emission sites.
 */
function commandLifecycle(state: 'started' | 'completed' | 'cancelled', uuid: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'command_lifecycle',
      command_uuid: 'command-1',
      state,
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

describe('Claude command_lifecycle frames', () => {
  it('keeps queue bookkeeping off the transcript for a whole turn', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1', 'Reply with exactly PROBE_OK and nothing else.'))
    translator.handle(commandLifecycle('started', 'lifecycle-1'))
    translator.handle(assistantReply('assistant-1', 'PROBE_OK'))
    translator.handle(commandLifecycle('completed', 'lifecycle-2'))
    translator.handle(commandLifecycle('completed', 'lifecycle-3'))
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
    // The turn's real content is untouched.
    expect(
      state.items.flatMap((item) =>
        item.body.kind === 'message' && item.body.role === 'assistant' ? [item.body.blocks] : []
      )
    ).toEqual([[{ type: 'text', text: 'PROBE_OK' }]])
  })

  it('keeps a cancelled command off the transcript too', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(commandLifecycle('cancelled', 'lifecycle-4'))

    expect(providerFrameKinds(state.items)).toEqual([])
  })
})
