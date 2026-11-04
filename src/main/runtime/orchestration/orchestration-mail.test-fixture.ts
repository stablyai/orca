import { formatMessageBannerWithContent } from './formatter'
import type { MessageRow } from './types'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'

export function orchestrationMailFixture(overrides: Partial<MessageRow> = {}): NativeChatMessage & {
  from: AgentMessageSource
} {
  const row: MessageRow = {
    id: 'msg_review',
    run_id: 'run_review',
    from_handle: 'term_worker',
    to_handle: 'run:run_review',
    subject: 'Review complete',
    body: 'The result is ready.',
    type: 'question',
    priority: 'normal',
    payload: null,
    thread_id: null,
    read: 0,
    sequence: 1,
    created_at: '2026-11-03T12:00:00Z',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
  const { text, content } = formatMessageBannerWithContent(row)
  return {
    id: row.id,
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
    from: {
      kind: 'agent',
      senders: [
        {
          name: 'Review worker',
          agent: 'codex',
          relation: 'worker',
          party: { address: row.from_handle, terminalHandle: row.from_handle, orcaSessionId: null }
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: row.to_handle,
        dispatchId: null,
        messages: [{ messageId: row.id, runId: row.run_id, from: row.from_handle, content }]
      }
    }
  }
}
