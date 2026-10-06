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
        { id: 'm1', from_handle: 'term_a', run_id: 'r1' },
        { id: 'm2', from_handle: `orca_session_id:${SESSION}`, run_id: 'r2' },
        { id: 'm3', from_handle: 'term_a', run_id: 'r1' }
      ]
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        { party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null } },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            orcaSessionId: SESSION
          }
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
})
