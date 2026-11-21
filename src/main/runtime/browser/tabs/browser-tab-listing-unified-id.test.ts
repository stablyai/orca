import { describe, expect, it } from 'vitest'
import { mergeBrowserTabListing } from './browser-tab-listing'

const entry = {
  browserPageId: 'page-1',
  unifiedTabId: 'tab-1',
  worktreeId: 'repo::/w',
  title: 'Google',
  url: 'https://www.google.com/',
  loadError: null,
  certificateFailure: null
}

describe('mergeBrowserTabListing unifiedTabId', () => {
  it('lists the workspace tab id Copy Tab ID copies for a saved page', () => {
    const [tab] = mergeBrowserTabListing({ tabBar: [entry], liveTabs: [], clientTabs: [] })
    expect(tab).toMatchObject({ browserPageId: 'page-1', unifiedTabId: 'tab-1' })
  })

  it('keeps it when the page is live', () => {
    const live = {
      browserPageId: 'page-1',
      index: 0,
      url: entry.url,
      title: 'Google',
      active: true
    }
    const [tab] = mergeBrowserTabListing({ tabBar: [entry], liveTabs: [live], clientTabs: [] })
    expect(tab).toMatchObject({ browserPageId: 'page-1', unifiedTabId: 'tab-1', loaded: true })
  })

  it('keeps it when a client-hosted row replaces the tab-bar entry', () => {
    const client = {
      browserPageId: 'page-1',
      index: 0,
      url: entry.url,
      title: 'Google',
      active: true
    }
    const tabs = mergeBrowserTabListing({ tabBar: [entry], liveTabs: [], clientTabs: [client] })
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ browserPageId: 'page-1', unifiedTabId: 'tab-1', loaded: true })
  })
})
