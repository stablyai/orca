import { expect, it } from 'vitest'
import { AgentSessionTabTable } from './agent-session-tab-table'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { agentSessionStoreRowChanges } from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'

function draft(state: AgentSessionStoreState): AgentSessionStoreState {
  return { ...state, sessionTabs: state.sessionTabs?.clone() ?? null }
}

function published(): AgentSessionStoreState {
  const sessionTabs = new AgentSessionTabTable([['tab-alpha', 'session-alpha']], ['session-bg'])
  sessionTabs.backgroundBackfilled = true
  return {
    records: new Map(),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs
  }
}

it('writes the background list and backfill mark only when they change', () => {
  const before = published()
  const shown = draft(before)
  shown.sessionTabs!.show('session-beta', 'tab-beta')
  expect(agentSessionStoreRowChanges(before, shown)?.sessionTabs).toMatchObject({
    background: null,
    backgroundBackfilled: false
  })

  const held = draft(before)
  held.sessionTabs!.holdInBackground('session-gamma')
  expect(agentSessionStoreRowChanges(before, held)?.sessionTabs?.background).toEqual([
    'session-bg',
    'session-gamma'
  ])
})
