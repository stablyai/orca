import { describe, expect, it } from 'vitest'
import { structuredMailSource } from './structured-mail-source'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

describe('who delivered mail is from', () => {
  it("names each sender once, without the pane key that would open its mailbox, and each message's own sender", () => {
    // No database: a terminal handle and a session address name their party by themselves.
    const source = structuredMailSource({
      db: null,
      mailboxHandle: 'run:r1',
      dispatchId: null,
      batch: [
        { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        {
          id: 'm2',
          from_handle: `orca_session_id:${SESSION}`,
          run_id: 'r2',
          type: 'status',
          payload: null
        },
        { id: 'm3', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }
      ],
      senderName: (party) => (party.terminalHandle === 'term_a' ? 'Build tab' : null)
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Build tab'
        },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            orcaSessionId: SESSION
          },
          name: null
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: null,
        messages: [
          { messageId: 'm1', runId: 'r1', from: 'term_a' },
          { messageId: 'm2', runId: 'r2', from: `orca_session_id:${SESSION}` },
          { messageId: 'm3', runId: 'r1', from: 'term_a' }
        ]
      }
    })
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        batch: [{ id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }],
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
