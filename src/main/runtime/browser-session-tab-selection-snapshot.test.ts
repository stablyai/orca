import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { applyBrowserSessionTabSelection } from './browser-session-tab-selection-snapshot'

const EPOCH = 'headless:test'

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

function select(overrides: { focusesHost: boolean; targetGroupId?: string }) {
  return applyBrowserSessionTabSelection({
    snapshot: makeSnapshot(),
    tabId: 'page-new',
    focusesHost: overrides.focusesHost,
    ...(overrides.targetGroupId ? { targetGroupId: overrides.targetGroupId } : {}),
    publicationEpoch: EPOCH
  })
}

describe('applyBrowserSessionTabSelection', () => {
  it('moves the shared active tab when the request reaches the host', () => {
    const { snapshot } = select({ focusesHost: true })

    expect(snapshot.activeTabId).toBe('page-new')
    expect(snapshot.activeTabType).toBe('browser')
    expect(snapshot.tabs.find((tab) => tab.id === 'page-new')?.isActive).toBe(true)
  })

  it('leaves every shared selection alone for a caller-addressed create', () => {
    const before = makeSnapshot()
    const { snapshot } = select({ focusesHost: false })

    expect(snapshot.activeTabId).toBe(before.activeTabId)
    expect(snapshot.activeTabType).toBe(before.activeTabType)
    expect(snapshot.activeGroupId).toBe(before.activeGroupId)
    expect(snapshot.tabs.find((tab) => tab.id === 'page-new')?.isActive).toBe(false)
    expect(snapshot.tabGroups?.find((group) => group.id === 'group-left')?.activeTabId).toBe(
      'terminal-tab'
    )
  })

  it('places the tab in the requested group whether or not the host follows', () => {
    for (const focusesHost of [true, false]) {
      const { snapshot, placedInTargetGroup } = select({
        focusesHost,
        targetGroupId: 'group-right'
      })

      expect(placedInTargetGroup).toBe(true)
      expect(snapshot.tabGroups?.find((group) => group.id === 'group-right')?.tabOrder).toEqual([
        'page-new'
      ])
      expect(snapshot.tabGroups?.find((group) => group.id === 'group-left')?.tabOrder).toEqual([
        'terminal-tab'
      ])
    }
  })

  it('claims the target group only for a host-following create', () => {
    expect(select({ focusesHost: true, targetGroupId: 'group-right' }).snapshot).toMatchObject({
      activeGroupId: 'group-right',
      tabGroups: expect.arrayContaining([
        expect.objectContaining({ id: 'group-right', activeTabId: 'page-new' })
      ])
    })
    expect(select({ focusesHost: false, targetGroupId: 'group-right' }).snapshot).toMatchObject({
      activeGroupId: 'group-left',
      tabGroups: expect.arrayContaining([
        expect.objectContaining({ id: 'group-right', activeTabId: null })
      ])
    })
  })

  it('reports an unknown group as unplaced so nothing is persisted for it', () => {
    const { placedInTargetGroup, snapshot } = select({
      focusesHost: true,
      targetGroupId: 'group-missing'
    })

    expect(placedInTargetGroup).toBe(false)
    expect(snapshot.activeGroupId).toBe('group-left')
  })

  it('republishes under a fresh epoch and a newer version either way', () => {
    for (const focusesHost of [true, false]) {
      const { snapshot } = select({ focusesHost })
      expect(snapshot.publicationEpoch).toBe(EPOCH)
      expect(snapshot.snapshotVersion).toBe(5)
    }
  })
})
