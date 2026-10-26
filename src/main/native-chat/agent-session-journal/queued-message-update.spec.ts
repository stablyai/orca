import { describe, expect, it } from 'vitest'
import { queuedMessageUpdateDecision } from './queued-message-update'
import type { QueuedMessageRow } from './queued-message-table'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'

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
    it('keeps sender, send mode and attachment order, replacing only the text', () => {
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
      expect(decision).toMatchObject({
        status: 'ready',
        body: {
          ...body,
          blocks: [body.blocks[0]!, { type: 'text', text: 'edited' }, body.blocks[2]!]
        }
      })
    })
    it('checks the resulting body before the expected base, making lost-answer retry safe', () => {
      const edited = card({ ...initial, blocks: [{ type: 'text', text: 'edit' }] })
      const base = agentSessionSendBodyFingerprint(sessionId, initial)
      expect(decide(edited, 'edit', base).status).toBe('unchanged')
      expect(decide(edited, 'other', base).status).toBe('changed')
      expect(decide(card(), 'edit').status).toBe('ready')
    })
    it('refuses empty, oversized, command and unsupported bodies', () => {
      expect(decide(card(), '  ').status).toBe('not-editable')
      expect(decide(card(), 'é'.repeat(MAX_PROMPT_BYTES)).status).toBe('not-editable')
      expect(decide(card({ ...initial, command: { name: 'compact' } }), 'edit').status).toBe(
        'not-editable'
      )
      const unsupported = card({
        ...initial,
        blocks: [{ type: 'tool-result', callId: 'tool', output: 'retained' }]
      })
      expect(decide(unsupported, 'edit').status).toBe('not-editable')
    })
    it('allows empty text with a retained attachment, and inserts text before one with none', () => {
      const captioned = card({
        ...initial,
        blocks: [
          { type: 'text', text: 'caption' },
          { type: 'image-ref', path: 'file.png' }
        ]
      })
      expect(decide(captioned, '')).toMatchObject({
        body: {
          blocks: [
            { type: 'text', text: '' },
            { type: 'image-ref', path: 'file.png' }
          ]
        }
      })
      const imageOnly = card({ ...initial, blocks: [{ type: 'image-ref', path: 'file.png' }] })
      expect(decide(imageOnly, 'added')).toMatchObject({
        body: {
          blocks: [
            { type: 'text', text: 'added' },
            { type: 'image-ref', path: 'file.png' }
          ]
        }
      })
    })
    it('a returned card stays editable; a dispatched, withdrawn or missing one answers gone', () => {
      expect(decide(card(initial, 'returned'), 'edit').status).toBe('ready')
      expect(decide(card(initial, 'dispatched'), 'edit')).toMatchObject({
        status: 'gone',
        disposition: 'dispatched'
      })
      expect(decide(card(initial, 'withdrawn'), 'edit')).toMatchObject({
        status: 'gone',
        disposition: 'withdrawn'
      })
      expect(decide(null, 'edit')).toMatchObject({ status: 'gone', disposition: 'missing' })
    })
  })
}
