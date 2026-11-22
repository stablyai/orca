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
    const favicons = new BrowserTabFaviconDataUrls({
      fetchFor: () => fetch,
      encoder: () => undefined,
      onInlined
    })
    const first = snapshot('https://site.test/favicon.png')

    expect(favicons.inline(first)).toBe(first)
    await vi.waitFor(() => expect(onInlined).toHaveBeenCalledWith('wt-1'))

    expect(favicons.inline(first).tabs[0]).toMatchObject({
      faviconUrl: `data:image/png;base64,${PNG_BASE64}`
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches on the route of the tab that shows the icon', async () => {
    const onInlined = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(Buffer.from(PNG_BASE64, 'base64'), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        })
    )
    const fetchFor = vi.fn(() => fetch)
    const favicons = new BrowserTabFaviconDataUrls({
      fetchFor,
      encoder: () => undefined,
      onInlined
    })

    favicons.inline(snapshot('https://site.test/favicon.png'))
    await vi.waitFor(() => expect(onInlined).toHaveBeenCalled())

    expect(fetchFor).toHaveBeenCalledWith('b1')
  })

  it('leaves the icon unfetched when the tab has no route of its own on this host', async () => {
    const onInlined = vi.fn()
    const favicons = new BrowserTabFaviconDataUrls({
      fetchFor: () => null,
      encoder: () => undefined,
      onInlined
    })
    const routed = snapshot('https://site.test/favicon.png')

    expect(favicons.inline(routed)).toBe(routed)
    expect(favicons.inline(routed)).toBe(routed)
    expect(onInlined).not.toHaveBeenCalled()
  })

  it.each([
    'https://10.0.0.5/favicon.png',
    'https://192.168.1.1/favicon.png',
    'https://169.254.169.254/favicon.png',
    'https://[fd00::1]/favicon.png',
    'https://[fe80::1]/favicon.png',
    'https://printer.local/favicon.png'
  ])('requests nothing for the private address %s', async (url) => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    const favicons = new BrowserTabFaviconDataUrls({
      fetchFor: () => fetch,
      encoder: () => undefined,
      onInlined: vi.fn()
    })

    favicons.inline(snapshot(url))
    await new Promise((resolve) => setImmediate(resolve))

    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not follow a redirect to a private address', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/favicon.png' } })
    )
    const favicons = new BrowserTabFaviconDataUrls({
      fetchFor: () => fetch,
      encoder: () => undefined,
      onInlined: vi.fn()
    })

    favicons.inline(snapshot('https://site.test/favicon.png'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setImmediate(resolve))

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('https://site.test/favicon.png', expect.anything())
  })
})
