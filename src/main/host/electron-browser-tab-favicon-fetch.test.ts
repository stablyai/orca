import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fromId, getGuestWebContentsId, manualFetch } = vi.hoisted(() => ({
  fromId: vi.fn(),
  getGuestWebContentsId: vi.fn(),
  manualFetch: vi.fn()
}))
vi.mock('electron', () => ({ webContents: { fromId } }))
vi.mock('../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { getGuestWebContentsId }
}))
vi.mock('./electron-manual-redirect-fetch', () => ({
  fetchWithElectronManualRedirects: manualFetch
}))

import { electronBrowserTabFaviconFetch } from './electron-browser-tab-favicon-fetch'

function guestSession(proxy: string, addresses: string[]) {
  return {
    resolveProxy: vi.fn(async () => proxy),
    resolveHost: vi.fn(async () => ({ endpoints: addresses.map((address) => ({ address })) }))
  }
}

function mountGuest(session: ReturnType<typeof guestSession>): void {
  getGuestWebContentsId.mockImplementation((pageId: string) => (pageId === 'page-1' ? 7 : null))
  fromId.mockImplementation((id: number) =>
    id === 7 ? { session, isDestroyed: () => false } : undefined
  )
}

beforeEach(() => {
  fromId.mockReset()
  getGuestWebContentsId.mockReset()
  manualFetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
})

describe('electronBrowserTabFaviconFetch', () => {
  it('requests the icon on the session of the page that shows it', async () => {
    const session = guestSession('SOCKS5 127.0.0.1:49152', [])
    mountGuest(session)
    const init = {}

    await electronBrowserTabFaviconFetch('page-1')?.('https://site.test/favicon.png', init)

    expect(manualFetch).toHaveBeenCalledWith('https://site.test/favicon.png', init, session)
    // The SSH side resolves the name; a lookup here would leave by the desktop's network.
    expect(session.resolveHost).not.toHaveBeenCalled()
  })

  it('offers no fetch for a page without a live guest', () => {
    mountGuest(guestSession('DIRECT', ['93.184.216.34']))

    expect(electronBrowserTabFaviconFetch('page-2')).toBeNull()
  })

  it.each(['10.1.2.3', '127.0.0.1', '169.254.169.254', 'fd00::1'])(
    'refuses a name that resolves to %s on a direct route',
    async (address) => {
      mountGuest(guestSession('DIRECT', ['93.184.216.34', address]))

      await expect(
        electronBrowserTabFaviconFetch('page-1')?.('https://intranet.example/favicon.png', {})
      ).rejects.toThrow('browser_tab_favicon_private_destination')
      expect(manualFetch).not.toHaveBeenCalled()
    }
  )

  it('requests a name that resolves to a public address on a direct route', async () => {
    mountGuest(guestSession('DIRECT', ['93.184.216.34']))

    await electronBrowserTabFaviconFetch('page-1')?.('https://site.test/favicon.png', {})

    expect(manualFetch).toHaveBeenCalledTimes(1)
  })
})
