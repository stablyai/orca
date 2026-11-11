import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'

function snapshot(activeTabId = 'terminal-a::leaf-a'): RuntimeMobileSessionTabsResult {
  const tabs = [
    {
      type: 'terminal' as const,
      id: 'terminal-a::leaf-a',
      parentTabId: 'terminal-a',
      leafId: 'leaf-a',
      title: 'A',
      isActive: activeTabId === 'terminal-a::leaf-a',
      status: 'ready' as const,
      terminal: 'term-a'
    },
    {
      type: 'terminal' as const,
      id: 'terminal-a::leaf-b',
      parentTabId: 'terminal-a',
      leafId: 'leaf-b',
      title: 'A split',
      isActive: activeTabId === 'terminal-a::leaf-b',
      status: 'ready' as const,
      terminal: 'term-b'
    },
    {
      type: 'browser' as const,
      id: 'browser-unified',
      browserWorkspaceId: 'browser-workspace',
      browserPageId: 'page-1',
      title: 'Browser',
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: activeTabId === 'browser-unified'
    }
  ]
  return {
    worktree: 'wt-1',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: 'group-left',
    activeTabId,
    activeTabType: activeTabId === 'browser-unified' ? 'browser' : 'terminal',
    tabGroups: [
      { id: 'group-left', activeTabId: 'terminal-a', tabOrder: ['terminal-a'] },
      { id: 'group-right', activeTabId: 'browser-unified', tabOrder: ['browser-unified'] }
    ],
    tabs
  }
}

function browserStrip(
  tabOrder: string[],
  options: { hostActiveTabId?: string; hostRecentTabIds?: string[] } = {}
): RuntimeMobileSessionTabsResult {
  const hostActiveTabId = options.hostActiveTabId ?? tabOrder[0]!
  return {
    worktree: 'wt-1',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: hostActiveTabId,
    activeTabType: 'browser',
    tabGroups: [
      {
        id: 'group',
        activeTabId: hostActiveTabId,
        tabOrder,
        ...(options.hostRecentTabIds ? { recentTabIds: options.hostRecentTabIds } : {})
      }
    ],
    tabs: tabOrder.map((id) => ({
      type: 'browser' as const,
      id,
      browserWorkspaceId: `workspace-${id}`,
      browserPageId: `page-${id}`,
      title: id,
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: id === hostActiveTabId
    }))
  }
}

describe('client session-tab selection', () => {
  it('does not restore a closed tab from a stale pre-close snapshot', () => {
    const store = new ClientSessionTabSelectionStore()
    const full = snapshot()
    store.activate(full, 'device-a', 'browser-unified')
    store.activate(full, 'device-b', 'browser-unified')

    store.forgetTabs('wt-1', ['browser-unified'])

    for (const clientId of ['device-a', 'device-b']) {
      const stale = store.project(full, clientId)
      expect(stale.activeTabId).toBe('terminal-a::leaf-a')
      expect(stale.tabs.some((tab) => tab.id === 'browser-unified')).toBe(false)
    }

    const withoutBrowser = {
      ...full,
      activeTabId: 'terminal-a::leaf-a',
      activeTabType: 'terminal' as const,
      tabGroups: full.tabGroups?.slice(0, 1),
      tabs: full.tabs.filter((tab) => tab.id !== 'browser-unified')
    }
    store.project(withoutBrowser, 'device-a')
    const reused = store.project(full, 'device-a')
    expect(reused.activeTabId).toBe('terminal-a::leaf-a')
    expect(reused.tabs.some((tab) => tab.id === 'browser-unified')).toBe(true)
  })
})

it('reopening caller visibility retains host-follow policy without changing a bystander close', () => {
  const store = new ClientSessionTabSelectionStore()
  const tabs = browserStrip(['a', 'b'])
  store.project(tabs, 'caller')
  store.project(tabs, 'bystander')
  store.forgetTabs('wt-1', ['a'])
  const before = store.project(tabs, 'caller')
  expect(before.activeTabId).toBe('b')
  expect(store.serialize()).toEqual({})
  const reopened = store.reopen(tabs, 'caller', 'a')
  expect(reopened.activeTabId).toBe('a')
  expect(store.project(tabs, 'caller').activeTabId).toBe('a')
  expect(store.project(tabs, 'bystander').activeTabId).toBe('b')
  expect(
    store.project(browserStrip(['a', 'b'], { hostActiveTabId: 'b' }), 'caller').activeTabId
  ).toBe('b')
  expect(store.serialize()).toEqual({})
})
