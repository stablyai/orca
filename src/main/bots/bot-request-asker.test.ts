import { describe, expect, it } from 'vitest'
import { connectorAskerHeader } from '../../shared/connector-asker-prompt'
import { ConnectorAsker } from '../../shared/connector-asker-contract'
import { storedConnectorAsker } from '../../shared/connector-message-asker'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import { connectorAskerTagView } from '../../shared/connectors/connector-message-asker-view'
import { firstMessageActsFor } from './bot-request-asker'

const t = (_key: string, fallback: string): string => fallback

// A request another Slack app on Who can ask made, wrongly marked as the owner's.
const appAsker = ConnectorAsker.parse({
  userId: 'U0CIAPP',
  name: 'CI (bot)',
  role: 'owner',
  place: { kind: 'public_channel', id: 'C0GENERAL' },
  text: 'the deploy failed',
  context: [],
  app: true
})

describe('an app asker that came marked as the owner', () => {
  it('never acts for the owner, nor reads or is told as them', () => {
    const asker = storedConnectorAsker('slack', appAsker)!
    expect(asker.role).toBe('member')
    const acts = firstMessageActsFor(
      [
        {
          itemId: 'm1',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [], asker }
        }
      ],
      { botRequestAskers: () => null, conversationWorkspaceId: 'T1' }
    )
    expect(acts).toEqual([expect.objectContaining({ kind: 'person', role: null })])
    expect(actsForOwner(acts!)).toBe(false)
    expect(connectorAskerTagView({ ...asker, role: 'owner' }, t).own).toBe(false)
    expect(connectorAskerHeader('slack', appAsker)).not.toContain('(your owner)')
  })
})
