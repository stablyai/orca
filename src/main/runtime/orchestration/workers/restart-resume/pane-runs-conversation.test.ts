import { expect, it } from 'vitest'
import { paneConversation, paneLiveSessions } from './pane-runs-conversation'

type Pane = Parameters<typeof paneLiveSessions>[0]

function pane(rows: ReturnType<Pane['getAgentStatusRowsForPane']>): Pane {
  return { getAgentStatusRowsForPane: () => rows }
}

it('names only conversations a live agent reported, not rows its lost process left behind', () => {
  const left = pane([
    { providerSession: { key: 'session_id', id: 'thread-1' }, providerSessionOnly: true },
    { providerSession: { key: 'session_id', id: 'thread-1' }, restoredUnconfirmed: true }
  ])
  expect(paneLiveSessions(left, 'pane')).toEqual([])
  expect(paneConversation(left, 'pane', 'thread-1')).toBe('unknown')
  const live = pane([{ providerSession: { key: 'session_id', id: 'thread-2' } }])
  expect(paneLiveSessions(live, 'pane')).toEqual(['thread-2'])
  expect(paneConversation(live, 'pane', 'thread-1')).toBe('other')
})
