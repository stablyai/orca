import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { replaceConversationInSnapshot } from './structured-conversation-tab-replacement'

describe('conversation pane replacement', () => {
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'folder',
    publicationEpoch: 'epoch',
    snapshotVersion: 4,
    activeGroupId: 'right',
    activeTabId: 'old-tab',
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: 'old-tab',
        sessionId: 'old-session',
        agent: 'claude',
        title: 'Old title',
        isActive: true,
        isPinned: true
      }
    ],
    tabGroups: [
      { id: 'right', tabOrder: ['old-tab'], activeTabId: 'old-tab', recentTabIds: ['old-tab'] }
    ]
  }
  const replacement = {
    workspaceId: 'folder',
    sourceSessionId: 'old-session',
    sessionId: 'new-session',
    agent: 'claude' as const
  }
  it('preserves group, position, selection and pinning while resetting identity/title', () => {
    const result = replaceConversationInSnapshot(snapshot, replacement)
    expect(result).toMatchObject({
      publicationEpoch: 'epoch',
      snapshotVersion: 5,
      activeGroupId: 'right',
      activeTabId: 'agent-session:new-session'
    })
    expect(result.tabs[0]).toMatchObject({
      sessionId: 'new-session',
      title: 'Claude Chat',
      replacesSessionId: 'old-session',
      isPinned: true
    })
    expect(result.tabGroups?.[0]).toMatchObject({
      tabOrder: ['agent-session:new-session'],
      recentTabIds: ['agent-session:new-session']
    })
    expect(snapshot.tabs[0]).toMatchObject({ sessionId: 'old-session' })
    expect(replaceConversationInSnapshot(result, replacement)).toBe(result)
  })
  it('does not touch another workspace', () => {
    expect(
      replaceConversationInSnapshot(snapshot, { ...replacement, workspaceId: 'elsewhere' })
    ).toBe(snapshot)
  })
})
