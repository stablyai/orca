import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OrchestrationDb } from './db'
import { locateOrchestrationParty } from './orchestration-party-location'
import { structuredMailSource } from './structured-mail-source'

describe('who delivered mail is from', () => {
  it('keeps sender recovery readable by a client from before full-content mail', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const message = db.insertMessage({
        from: 'term_previous',
        to: 'run:r1',
        subject: 'report',
        senderPaneKey: 'pane-worker'
      })
      const source = structuredMailSource({
        db,
        mailboxHandle: message.to_handle,
        dispatchId: null,
        message,
        senderName: () => 'Worker'
      })
      // The published mail schema before full-content delivery; unknown fields are stripped.
      const legacy = z
        .object({
          message: z.literal('mail-notice'),
          mailbox: z.string(),
          dispatchId: z.string().nullable(),
          messages: z.array(
            z.object({ messageId: z.string(), runId: z.string(), from: z.string() })
          )
        })
        .parse(source.orchestration)
      const messageIds = legacy.messages
        .filter((mail) => mail.from === 'term_previous')
        .map((mail) => mail.messageId)
      expect(
        locateOrchestrationParty(
          'term_previous',
          {
            db,
            records: null,
            terminalPaneKey: () => null,
            terminalHandleForPaneKey: (pane) => (pane === 'pane-worker' ? 'term_current' : null)
          },
          messageIds
        )
      ).toEqual({ location: { kind: 'terminal', handle: 'term_current' } })
    } finally {
      db.close()
    }
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        message: { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        senderName
      }).senders[0]?.name
    expect(named(() => `  Build\n${'x'.repeat(400)}`)).toHaveLength(200)
    expect(named(() => '   ')).toBeNull()
    expect(
      named(() => {
        throw new Error('records unavailable')
      })
    ).toBeNull()
  })
})
