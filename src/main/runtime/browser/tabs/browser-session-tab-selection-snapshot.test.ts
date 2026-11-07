import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import { applyBrowserSessionTabSelection } from './browser-session-tab-selection-snapshot'

function makeSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'headless:before',
    snapshotVersion: 4,
    activeGroupId: 'group-left',
    activeTabId: 'terminal-tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'terminal-tab',
        parentTabId: 'terminal-tab',
        leafId: 'leaf-1',
        title: 'Terminal',
        isActive: true
      },
      {
        type: 'browser',
        id: 'page-new',
        browserWorkspaceId: 'page-new',
        browserPageId: 'page-new',
        title: 'New',
        url: 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      }
    ] as RuntimeMobileSessionTabsSnapshot['tabs'],
    tabGroups: [
      { id: 'group-left', tabOrder: ['terminal-tab', 'page-new'], activeTabId: 'terminal-tab' },
      { id: 'group-right', tabOrder: [], activeTabId: null }
    ] as RuntimeMobileSessionTabsSnapshot['tabGroups']
  }
}

describe('applyBrowserSessionTabSelection', () => {
  it('selects the owning group when a host switch targets an existing page in another group', () => {
    const before = makeSnapshot()
    before.tabGroups = [
      { id: 'group-left', tabOrder: ['terminal-tab'], activeTabId: 'terminal-tab' },
      { id: 'group-right', tabOrder: ['page-new'], activeTabId: 'page-new' }
    ]

    const { snapshot } = applyBrowserSessionTabSelection({
      snapshot: before,
      tabId: 'page-new',
      focusesHost: true
    })

    expect(snapshot.activeGroupId).toBe('group-right')
    expect(snapshot.activeTabId).toBe('page-new')
    expect(snapshot.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['page-new'])
    expect(snapshot.tabGroups?.[0]?.activeTabId).toBe('terminal-tab')
  })

  // Rotating the epoch here retires the renderer's own publication client-side.
})
