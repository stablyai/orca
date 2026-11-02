import { describe, expect, it } from 'vitest'
import type { BrowserTabInfo } from '../../../shared/runtime-browser-contracts'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import {
  mergeBrowserTabListing,
  readBrowserTabBar,
  type BrowserTabBarEntry
} from './browser-tab-listing'

function barEntry(browserPageId: string, worktreeId = 'wt-1'): BrowserTabBarEntry {
  return {
    browserPageId,
    worktreeId,
    title: `${browserPageId} title`,
    url: `https://${browserPageId}.test/`,
    loadError: null,
    certificateFailure: null
  }
}

function live(browserPageId: string, active = false): BrowserTabInfo {
  return {
    browserPageId,
    index: 9,
    url: `https://${browserPageId}.test/live`,
    title: `${browserPageId} live`,
    active,
    worktreeId: 'wt-1',
    profileId: 'default',
    profileLabel: 'Default'
  }
}

function snapshot(worktree: string, tabs: unknown[]): RuntimeMobileSessionTabsSnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test builds only the fields readBrowserTabBar reads.
  return { worktree, tabs } as RuntimeMobileSessionTabsSnapshot
}

function browserRow(
  browserPageId: string | null,
  extra: Partial<RuntimeMobileSessionBrowserTab> = {}
): RuntimeMobileSessionBrowserTab {
  return {
    type: 'browser',
    id: `tab-${browserPageId}`,
    title: `${browserPageId} title`,
    browserWorkspaceId: `ws-${browserPageId}`,
    browserPageId,
    url: `https://${browserPageId}.test/`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false,
    ...extra
  }
}

describe('mergeBrowserTabListing', () => {
  it('lists every tab-bar tab in order, marking those without a live page as not loaded', () => {
    const tabs = mergeBrowserTabListing({
      tabBar: [barEntry('a'), barEntry('b'), barEntry('c')],
      liveTabs: [live('c', true)],
      clientTabs: []
    })
    expect(tabs.map((tab) => [tab.index, tab.browserPageId, tab.loaded, tab.active])).toEqual([
      [0, 'a', false, false],
      [1, 'b', false, false],
      [2, 'c', true, true]
    ])
    expect(tabs[0]).toMatchObject({ title: 'a title', url: 'https://a.test/', profileId: null })
    expect(tabs[2]).toMatchObject({ title: 'c live', url: 'https://c.test/live' })
  })

  it('keeps live pages the tab bar does not show yet, after the bar', () => {
    const tabs = mergeBrowserTabListing({
      tabBar: [barEntry('a')],
      liveTabs: [live('new', true), live('a')],
      clientTabs: []
    })
    expect(tabs.map((tab) => [tab.browserPageId, tab.loaded])).toEqual([
      ['a', true],
      ['new', true]
    ])
  })

  it('lists client-hosted pages once, from the registry, after everything else', () => {
    const client = { ...live('remote'), active: true }
    const tabs = mergeBrowserTabListing({
      tabBar: [barEntry('remote'), barEntry('a')],
      liveTabs: [],
      clientTabs: [client]
    })
    expect(tabs.map((tab) => [tab.browserPageId, tab.loaded])).toEqual([
      ['a', false],
      ['remote', true]
    ])
  })

  it('lists an id held by both a live page and a client page once, as the client page', () => {
    const tabs = mergeBrowserTabListing({
      tabBar: [],
      liveTabs: [live('shared')],
      clientTabs: [{ ...live('shared'), title: 'client' }]
    })
    expect(tabs.map((tab) => [tab.browserPageId, tab.title])).toEqual([['shared', 'client']])
  })

  it('with nothing active, marks the first live page active, never an unloaded tab', () => {
    const tabs = mergeBrowserTabListing({
      tabBar: [barEntry('a'), barEntry('b'), barEntry('c')],
      liveTabs: [live('c'), live('b')],
      clientTabs: []
    })
    expect(tabs.map((tab) => [tab.browserPageId, tab.active])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true]
    ])
  })

  it('without a tab bar, lists live pages as before', () => {
    const tabs = mergeBrowserTabListing({
      tabBar: [],
      liveTabs: [live('x'), live('y')],
      clientTabs: []
    })
    expect(tabs.map((tab) => [tab.browserPageId, tab.active, tab.loaded])).toEqual([
      ['x', true, true],
      ['y', false, true]
    ])
  })
})

describe('readBrowserTabBar', () => {
  const snapshots = new Map([
    [
      'wt-1',
      snapshot('wt-1', [
        { type: 'terminal', id: 'term' },
        browserRow('a'),
        browserRow(null),
        browserRow('client', {
          placement: {
            kind: 'client',
            browserHostClientId: 'client-1',
            browserHostGeneration: 1,
            pageHostGeneration: 1
          }
        }),
        browserRow('b')
      ])
    ],
    ['wt-2', snapshot('wt-2', [browserRow('c')])],
    ['server-wt', snapshot('server-wt', [browserRow('mirrored')])]
  ])
  const ownsWorkspace = (worktreeId: string) => worktreeId !== 'server-wt'

  it("reads one worktree's local browser tabs in order", () => {
    expect(
      readBrowserTabBar(snapshots, 'wt-1', ownsWorkspace).map((entry) => entry.browserPageId)
    ).toEqual(['a', 'b'])
  })

  it("reads every worktree this host owns when none is named, skipping a paired server's mirror", () => {
    expect(
      readBrowserTabBar(snapshots, undefined, ownsWorkspace).map((entry) => [
        entry.worktreeId,
        entry.browserPageId
      ])
    ).toEqual([
      ['wt-1', 'a'],
      ['wt-1', 'b'],
      ['wt-2', 'c']
    ])
  })
})
