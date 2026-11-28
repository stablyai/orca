// Whose words opened a turn, for the owner's first run on a shared agent: a teammate's words, typed
// on their own device, never count as the owner's.
import { expect, it } from 'vitest'
import type { AgentJournalTypedBy } from '../../shared/agent-session/journal/agent-journal-typed-by'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { ownerOpened } from './bot-turn-rows'

function turnOpenedBy(typedBy: AgentJournalTypedBy): boolean {
  const items: AgentJournalRenderItem[] = [
    {
      itemId: 'u1',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [], typedBy }
    },
    {
      itemId: 't1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'p1', state: 'completed', userItemId: 'u1' }
    }
  ]
  return ownerOpened({ items, openerIds: new Map() }, 'p1')
}

it('counts the owner’s words, at the host or on their own device, and never a teammate’s', () => {
  const device = { by: 'device' as const, deviceId: 'd1', accountId: 'a1', account: 'x' }
  expect(turnOpenedBy({ by: 'host' })).toBe(true)
  expect(turnOpenedBy({ ...device, own: true })).toBe(true)
  expect(turnOpenedBy({ ...device, own: false })).toBe(false)
})
