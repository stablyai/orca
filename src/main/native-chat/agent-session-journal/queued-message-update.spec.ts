import { describe, expect, it } from 'vitest'
import { queuedMessageUpdateDecision } from './queued-message-update'
import type { QueuedMessageRow } from './queued-message-table'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'

export function registerQueuedMessageUpdateTests(): void {
  const sessionId = 'folder-session'
  const initial: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'base' }]
  }
  function card(body = initial, state: QueuedMessageRow['state'] = 'waiting'): QueuedMessageRow {
    return {
      messageId: 'card',
      position: 1,
      body,
      fingerprint: agentSessionSendBodyFingerprint(sessionId, body),
      state,
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: 'epoch', sequence: 4 }
    }
  }
  function decide(row: QueuedMessageRow | null, text: string, base = row?.fingerprint ?? '') {
    return queuedMessageUpdateDecision(row, sessionId, {
      messageId: 'card',
      expectedBodyFingerprint: base,
      text
    })
  }

  describe('queued text update decision', () => {
    it('attributes changed content to the user while keeping send mode and attachment order', () => {
      const body: AgentJournalMessageItem = {
        ...initial,
        sentAs: 'goal',
        from: { kind: 'agent', senders: [], orchestration: null },
        blocks: [
          { type: 'image-ref', path: 'before.png' },
          { type: 'text', text: 'one' },
          { type: 'image-ref', url: 'https://example.com/image.png' },
          { type: 'text', text: 'two' }
        ]
      }
      const decision = decide(card(body), 'edited')
      const { from: _sender, ...plain } = body
      expect(decision).toMatchObject({
        status: 'ready',
        body: {
          ...plain,
          blocks: [body.blocks[0]!, { type: 'text', text: 'edited' }, body.blocks[2]!]
        }
      })
      expect(decision).not.toHaveProperty('body.from')
    })
    it('checks the resulting body before the expected base, making lost-answer retry safe', () => {
      const edited = card({ ...initial, blocks: [{ type: 'text', text: 'edit' }] })
      const base = agentSessionSendBodyFingerprint(sessionId, initial)
      expect(decide(edited, 'edit', base).status).toBe('unchanged')
      expect(decide(edited, 'other', base).status).toBe('changed')
      expect(decide(card(), 'edit').status).toBe('ready')
    })
  })
}
