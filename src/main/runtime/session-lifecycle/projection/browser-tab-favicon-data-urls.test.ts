import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { BrowserTabFaviconDataUrls } from './browser-tab-favicon-data-urls'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function snapshot(faviconUrl: string): RuntimeMobileSessionTabsSnapshot {
  const tab: RuntimeMobileSessionBrowserTab = {
    type: 'browser',
    id: 'b1',
    title: 'Site',
    browserWorkspaceId: 'b1',
    browserPageId: 'b1',
    url: 'https://site.test/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true,
    faviconUrl
  }
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'b1',
    activeTabType: 'browser',
    tabs: [tab]
  }
}

describe('BrowserTabFaviconDataUrls', () => {
  it('publishes an https favicon as a data URL once fetched, and asks to republish its workspace', async () => {
    const onInlined = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(Buffer.from(PNG_BASE64, 'base64'), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        })
    )
    const favicons = new BrowserTabFaviconDataUrls({ fetch, encoder: () => undefined, onInlined })
    const first = snapshot('https://site.test/favicon.png')

    expect(favicons.inline(first)).toBe(first)
    await vi.waitFor(() => expect(onInlined).toHaveBeenCalledWith('wt-1'))

    expect(favicons.inline(first).tabs[0]).toMatchObject({
      faviconUrl: `data:image/png;base64,${PNG_BASE64}`
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
