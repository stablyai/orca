// Which turn a Claude row belongs to (B8): the root turn open when the row is written, whoever
// produced it, and the conversation once that turn has ended.

import { expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function recorder() {
  const writes: {
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
    options: StructuredAgentSessionItemAppendOptions
  }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => writes.push({ identity, body, options }),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  const scopeOfProse = (text: string) =>
    writes.findLast(
      (write) =>
        write.body.kind === 'message' &&
        write.body.blocks.some((block) => block.type === 'text' && block.text === text)
    )?.options.turnScope
  return { sink, writes, scopeOfProse }
}

function frame(message: Record<string, unknown>, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', ...message }
  }
}

function prose(uuid: string, text: string, parentToolUseId: string | null = null) {
  return frame({
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

it("scopes the session's and a subagent's rows to the open turn, and a late one to none", () => {
  const { sink, writes, scopeOfProse } = recorder()
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'test' })
  translator.handle(
    frame(
      {
        type: 'user',
        uuid: 'user-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
      },
      true
    )
  )
  translator.handle(prose('assistant-1', 'Working on it'))
  translator.handle(prose('child-1', 'Child mid-turn', 'toolu_1'))
  translator.handle(frame({ type: 'result', subtype: 'success', uuid: 'result-1', result: 'ok' }))
  translator.handle(prose('child-2', 'Child after the turn', 'toolu_1'))

  const turnRecord = writes.find((write) => write.body.kind === 'turn')
  expect(turnRecord?.options.turnScope).toEqual({ kind: 'thread' })
  const turnKey = expect.stringContaining('turn-lifecycle')
  expect(scopeOfProse('Working on it')).toEqual({ kind: 'turn', turnItemId: turnKey })
  expect(scopeOfProse('Child mid-turn')).toEqual({ kind: 'turn', turnItemId: turnKey })
  expect(scopeOfProse('Child after the turn')).toEqual({ kind: 'thread' })
})
