import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  retitleStructuredConversationTab,
  titleStructuredConversationTabs
} from './structured-conversation-tab-title'

const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'workspace-1',
  publicationEpoch: 'epoch-1',
  snapshotVersion: 2,
  activeGroupId: null,
  activeTabId: 'agent-session:session-1',
  activeTabType: 'agent-session',
  tabs: [
    {
      type: 'agent-session',
      id: 'agent-session:session-1',
      sessionId: 'session-1',
      title: 'Claude Chat',
      agent: 'claude',
      isActive: true
    }
  ]
}

describe('structured conversation tab title', () => {
  it('bumps the stored snapshot version only when the title changes', () => {
    const titled = retitleStructuredConversationTab(snapshot, 'session-1', 'auth/login')
    expect(titled).toMatchObject({
      snapshotVersion: 3,
      tabs: [{ title: 'auth/login' }]
    })
    expect(retitleStructuredConversationTab(titled!, 'session-1', 'auth/login')).toBeNull()
    expect(retitleStructuredConversationTab(titled!, 'session-1', null)?.tabs[0]).toMatchObject({
      title: 'Claude Chat'
    })
  })

  it('projects only the title from the record at read time', () => {
    const projected = titleStructuredConversationTabs(snapshot, () => 'auth/login')
    expect(projected.tabs[0]).toMatchObject({ title: 'auth/login', sessionId: 'session-1' })
    expect(projected.snapshotVersion).toBe(snapshot.snapshotVersion)
    expect(titleStructuredConversationTabs(projected, () => null).tabs[0]).toMatchObject({
      title: 'Claude Chat'
    })
  })
})
