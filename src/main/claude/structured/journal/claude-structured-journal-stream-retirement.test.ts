import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const translators: ReturnType<typeof createClaudeJournalTranslator>[] = []
afterEach(() => {
  for (const translator of translators.splice(0)) {
    translator.dispose()
  }
})

function journal() {
  const writes: {
    key: string
    body: AgentJournalItemBody
    options?: StructuredAgentSessionAppendOptions
  }[] = []
  const translator = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body, options) =>
        writes.push({ key: agentJournalItemKey(identity), body, options }),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  translators.push(translator)
  const frame = (message: Record<string, unknown>, startsTurn = false) =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      observedAt: 1_000,
      ...(startsTurn ? { startsTurn: true } : {}),
      message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
    })
  const send = (uuid: string) =>
    frame({ type: 'user', uuid, message: { role: 'user', content: 'go' } }, true)
  const delta = (
    uuid: string,
    text: string,
    parent: string | null = null,
    index = 0,
    kind: 'text' | 'thinking' = 'text'
  ) =>
    frame({
      type: 'stream_event',
      uuid,
      parent_tool_use_id: parent,
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: `${kind}_delta`, [kind]: text }
      }
    })
  const final = (
    uuid: string,
    text: string,
    kind: 'text' | 'thinking' = 'text',
    messageId?: string
  ) =>
    frame({
      type: 'assistant',
      uuid,
      parent_tool_use_id: 'agent-tool',
      message: { id: messageId, role: 'assistant', content: [{ type: kind, [kind]: text }] }
    })
  const row = (key: string) => writes.findLast((write) => write.key === key)
  return { translator, writes, frame, send, delta, final, row }
}

describe('Claude stream retirement', () => {
  it.each(['send', 'command'] as const)(
    'ends only the superseded root when a new %s arrives without a result',
    (superseder) => {
      const { translator, writes, send, delta, final, row } = journal()
      send('prompt-a')
      delta('root-a', 'Partial A')
      delta('child-c', 'Child ', 'agent-tool')
      delta('child-thinking', 'Considering ', 'agent-tool', 1, 'thinking')
      translator.flush()

      if (superseder === 'send') {
        send('prompt-b')
      } else {
        translator.beginCommand({
          providerSessionId: 'claude-session',
          sentUuid: 'command-send',
          clientMessageId: 'command-client',
          turnId: 'command',
          identity: { provider: 'orca', clientMessageId: 'command-client' },
          resultIdentity: { provider: 'orca', clientMessageId: 'command-result' },
          running: { kind: 'turn', turnId: 'command', state: 'running', startedAt: 2_000 }
        })
      }

      expect(row('claude:claude-session:root-a')).toMatchObject({
        body: { kind: 'message', blocks: [{ type: 'text', text: 'Partial A' }] },
        options: { lifecycle: true }
      })
      expect(
        writes.filter((write) => write.key === 'claude:claude-session:child-thinking')
      ).not.toContainEqual(
        expect.objectContaining({ options: expect.objectContaining({ lifecycle: true }) })
      )
      expect(row('claude:claude-session:child-c')?.options?.lifecycle).not.toBe(true)

      if (superseder === 'command') {
        translator.forgetCommand('command')
        send('prompt-b')
      }
      delta('root-b', 'Reply B')
      delta('child-c-next', 'complete', 'agent-tool')
      delta('child-thinking-next', 'complete', 'agent-tool', 1, 'thinking')
      translator.flush()
      final('child-final', 'Child complete')
      final('thinking-final', 'Considering complete', 'thinking')

      expect(row('claude:claude-session:root-a')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'Partial A' }]
      })
      expect(row('claude:claude-session:root-b')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'Reply B' }]
      })
      expect(row('claude:claude-session:child-c')).toMatchObject({
        body: { blocks: [{ type: 'text', text: 'Child complete' }] },
        options: { lifecycle: true }
      })
      expect(row('claude:claude-session:child-thinking')).toMatchObject({
        body: {
          role: 'reasoning',
          state: 'completed',
          blocks: [{ type: 'text', text: 'Considering complete' }]
        },
        options: { lifecycle: true }
      })
      expect(row('claude:claude-session:child-c-next')).toBeUndefined()
      expect(row('claude:claude-session:child-final')).toBeUndefined()
    }
  )

  it.each(['text', 'thinking'] as const)(
    'keeps all expected child %s finals on their rows, then gives later deltas a fresh row',
    (kind) => {
      const { translator, send, delta, final, row } = journal()
      send('prompt')
      delta('first-block', 'First ', 'agent-tool', 0, kind)
      delta('second-block', 'Second ', 'agent-tool', 1, kind)
      translator.flush()
      final('first-final', 'First complete', kind)
      delta('second-next', 'complete', 'agent-tool', 1, kind)
      translator.flush()
      final('second-final', 'Second complete', kind)
      delta('later-block', 'Later message', 'agent-tool', 0, kind)
      translator.flush()

      expect(row('claude:claude-session:first-block')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'First complete' }]
      })
      expect(row('claude:claude-session:second-block')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'Second complete' }]
      })
      expect(row('claude:claude-session:later-block')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'Later message' }]
      })
      expect(row('claude:claude-session:second-next')).toBeUndefined()
      expect(row('claude:claude-session:first-final')).toBeUndefined()
      expect(row('claude:claude-session:second-final')).toBeUndefined()
    }
  )

  it.each([
    ['text', 'before'],
    ['text', 'after'],
    ['thinking', 'before'],
    ['thinking', 'after']
  ] as const)(
    'keeps sequential %s block identities until message_stop %s the last final',
    (kind, stopOrder) => {
      const { translator, frame, send, delta, final, row } = journal()
      send('prompt')
      frame({
        type: 'stream_event',
        uuid: 'message-start',
        parent_tool_use_id: 'agent-tool',
        event: { type: 'message_start', message: { id: 'child-message' } }
      })
      delta('first-block', 'First ', 'agent-tool', 0, kind)
      final('first-final', 'First complete', kind, 'child-message')
      delta('second-block', 'Second ', 'agent-tool', 1, kind)
      translator.flush()
      const stop = () =>
        frame({
          type: 'stream_event',
          uuid: 'message-stop',
          parent_tool_use_id: 'agent-tool',
          event: { type: 'message_stop' }
        })
      if (stopOrder === 'before') {
        stop()
      }
      final('second-final', 'Second complete', kind, 'child-message')
      if (stopOrder === 'after') {
        stop()
      }
      delta('later-block', 'Later message', 'agent-tool', 0, kind)
      translator.flush()

      expect(row('claude:claude-session:block%3Achild-message%3A0')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'First complete' }]
      })
      expect(row('claude:claude-session:block%3Achild-message%3A1')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'Second complete' }]
      })
      expect(row('claude:claude-session:later-block')?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'Later message' }]
      })
      expect(row('claude:claude-session:second-block')).toBeUndefined()
      expect(row('claude:claude-session:second-final')).toBeUndefined()
    }
  )
})
