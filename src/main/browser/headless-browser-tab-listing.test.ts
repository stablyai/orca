import { describe, expect, it } from 'vitest'
import type { BrowserTabInfo } from '../../shared/runtime-types'
import type { ParkedBrowserPage } from './browser-backend'
import { mergeParkedBrowserTabs } from './headless-browser-tab-listing'

function live(browserPageId: string, index: number, active = false): BrowserTabInfo {
  return {
    browserPageId,
    index,
    url: `https://example.test/${browserPageId}`,
    title: browserPageId,
    active
  }
}

function parked(browserPageId: string, active = false): ParkedBrowserPage {
  return {
    browserPageId,
    worktreeId: 'wt-1',
    profileId: 'default',
    url: `https://example.test/${browserPageId}`,
    title: browserPageId,
    active
  }
}

describe('mergeParkedBrowserTabs', () => {
  it('returns the live listing untouched when nothing is parked', () => {
    const tabs = [live('a', 0, true), live('b', 1)]
    expect(mergeParkedBrowserTabs(tabs, [])).toEqual(tabs)
  })

  it('appends parked pages with continuous indices', () => {
    const merged = mergeParkedBrowserTabs([live('a', 0, true)], [parked('b'), parked('c')])
    expect(merged.map((tab) => [tab.browserPageId, tab.index, tab.parked === true])).toEqual([
      ['a', 0, false],
      ['b', 1, true],
      ['c', 2, true]
    ])
  })

  it('lets a parked page stay active when nothing live claims it', () => {
    // Why: parking clears the bridge pointer, but the paired client's tab bar
    // must not lose its selection just because the renderer was reclaimed.
    const merged = mergeParkedBrowserTabs([], [parked('b', true), parked('c')])
    expect(merged.map((tab) => tab.active)).toEqual([true, false])
  })

  it('never reports two active tabs', () => {
    const merged = mergeParkedBrowserTabs([live('a', 0, true)], [parked('b', true)])
    expect(merged.filter((tab) => tab.active).map((tab) => tab.browserPageId)).toEqual(['a'])
  })

  it('carries worktree and profile identity for parked pages', () => {
    const [tab] = mergeParkedBrowserTabs([], [parked('b')])
    expect(tab).toMatchObject({
      browserPageId: 'b',
      worktreeId: 'wt-1',
      profileId: 'default',
      parked: true
    })
  })

  it('reports at most one active tab when several parked pages claim it', () => {
    // Why: `active` is a single selection. Parking the active page promotes
    // another live tab, which can later park claiming the flag as well.
    const merged = mergeParkedBrowserTabs([], [parked('b', true), parked('c', true)])
    expect(merged.filter((tab) => tab.active).map((tab) => tab.browserPageId)).toEqual(['b'])
  })

  it('orders by creation so parking never renumbers an index the caller read', () => {
    // Why: the bridge lists by registration order, which a park/wake cycle
    // mutates (a woken tab re-registers at the end). A tab created first must
    // stay at index 0 whether or not its renderer is currently reclaimed.
    const merged = mergeParkedBrowserTabs([live('b', 0, true)], [parked('a')], ['a', 'b'])
    expect(merged.map((tab) => [tab.browserPageId, tab.index, tab.parked === true])).toEqual([
      ['a', 0, true],
      ['b', 1, false]
    ])
  })

  it('reindexes an all-live listing when the creation order disagrees', () => {
    const merged = mergeParkedBrowserTabs([live('b', 0), live('a', 1, true)], [], ['a', 'b'])
    expect(merged.map((tab) => [tab.browserPageId, tab.index])).toEqual([
      ['a', 0],
      ['b', 1]
    ])
  })

  it('ignores stale ids in the creation order', () => {
    const merged = mergeParkedBrowserTabs([live('b', 0, true)], [parked('a')], ['closed', 'a', 'b'])
    expect(merged.map((tab) => [tab.browserPageId, tab.index])).toEqual([
      ['a', 0],
      ['b', 1]
    ])
  })

  it('keeps ids missing from the creation order at their merged position', () => {
    const merged = mergeParkedBrowserTabs([live('x', 0, true)], [parked('a')], ['a'])
    expect(merged.map((tab) => [tab.browserPageId, tab.index])).toEqual([
      ['a', 0],
      ['x', 1]
    ])
  })

  it('carries a parked page load failure into the listing', () => {
    const loadError = { code: -105, description: 'NAME_NOT_RESOLVED', validatedUrl: 'https://nope' }
    const [tab] = mergeParkedBrowserTabs([], [{ ...parked('b'), loadError }])
    expect(tab.loadError).toEqual(loadError)
  })
})
