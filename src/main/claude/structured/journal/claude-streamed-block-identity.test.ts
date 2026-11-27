import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const session = '584ed236-4030-4c59-b465-5c6c16668b6d'
let uuid = 0
const stream = (event: Record<string, unknown>) => ({
  type: 'stream_event',
  event,
  session_id: session,
  parent_tool_use_id: null,
  uuid: `stream-${uuid++}`
})
const final = (content: Record<string, unknown>) => ({
  type: 'assistant',
  message: { id: 'msg_gw_0', type: 'message', role: 'assistant', content: [content] },
  session_id: session,
  parent_tool_use_id: null,
  uuid: `final-${uuid++}`
})

// Recorded from Claude Code 2.1.332 behind a gateway that opens with a blank text block: the
// CLI streams that block but sends no final frame for it, so it must not claim the reply's.
it('keeps a gateway reply on one row when a blank text block streams first', () => {
  const rows = new Map<string, AgentJournalMessageItem>()
  const journal = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body) => {
        if (body.kind === 'message') {
          rows.set(agentJournalItemKey(identity), body)
        }
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  for (const message of [
    stream({
      type: 'message_start',
      message: { id: 'msg_gw_0', type: 'message', role: 'assistant', content: [] }
    }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\n' } }),
    stream({ type: 'content_block_stop', index: 0 }),
    stream({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '', signature: '' }
    }),
    stream({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'Let me think.' }
    }),
    final({ type: 'thinking', thinking: 'Let me think.', signature: 'sig' }),
    stream({ type: 'content_block_stop', index: 1 }),
    stream({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
    stream({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Hello from the ' }
    }),
    stream({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'gateway.' }
    }),
    final({ type: 'text', text: 'Hello from the gateway.' }),
    stream({ type: 'content_block_stop', index: 2 }),
    stream({ type: 'message_stop' })
  ]) {
    journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
  }
  const replies = [...rows].filter(([, body]) => body.role === 'assistant')
  expect(replies).toEqual([
    [
      agentJournalItemKey({ provider: 'claude', sessionId: session, uuid: 'block:msg_gw_0:2' }),
      expect.objectContaining({ blocks: [{ type: 'text', text: 'Hello from the gateway.' }] })
    ]
  ])
})
