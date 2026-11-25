import { describe, expect, it } from 'vitest'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { retryAskerOf } from './external-conversation-turn-ends'

const conversation = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
const stamp = (deliveryId: string): AgentJournalConnectorDelivery => ({
  account: 'account-a',
  conversation,
  deliveryId
})
const message = (fields: Partial<AgentJournalMessageItem>): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'fix it' }],
  ...fields
})
const place = { kind: 'channel', id: 'C1' } as const
const asker = { source: 'slack', userId: 'U1', role: 'member', place } as const

// A retry runs only for a turn one request opened and no other joined; it never carries that person's
// name, so Orca's own ask isn't shown as theirs.
describe('retryAskerOf', () => {
  it('retries, naming no one, only when the opener carried every request', () => {
    const opener = message({ connectorDelivery: stamp('d1'), asker, origin: 'connector' })
    expect(retryAskerOf(opener, [stamp('d1')]).askedBy).toEqual({ origin: 'connector' })
    expect(retryAskerOf(opener, [stamp('d1'), stamp('d2')]).askedBy).toBeUndefined()
    expect(retryAskerOf(message({}), [stamp('d1')]).askedBy).toBeUndefined()
    const elsewhere = { ...stamp('d1'), account: 'account-b' }
    expect(retryAskerOf(opener, [stamp('d1'), elsewhere]).askedBy).toBeUndefined()
  })

  it('asks for no one named in a continuation of one cut request, and not at all for several', () => {
    const claim = (origin: AgentJournalConnectorDelivery[]) =>
      message({ connectorClaim: { cutTurnId: 't', cutKind: 'restart', origin } })
    const one = [stamp('d1')]
    const both = [stamp('d1'), stamp('d2')]
    expect(retryAskerOf(claim(one), one).askedBy).toEqual({ origin: 'connector' })
    expect(retryAskerOf(claim(both), both).askedBy).toBeUndefined()
    expect(retryAskerOf(claim(one), both).askedBy).toBeUndefined()
  })
})
