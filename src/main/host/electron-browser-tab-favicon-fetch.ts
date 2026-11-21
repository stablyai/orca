import { isIP } from 'node:net'
import { webContents, type Session } from 'electron'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { isBlockedAddress, isBlockedHost } from '../link-preview/link-preview-address-guard'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'

async function assertPublicDestination(session: Session, url: string): Promise<void> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (isBlockedHost(hostname)) {
    throw new Error('browser_tab_favicon_private_destination')
  }
  if (isIP(hostname) !== 0) {
    return
  }
  // A proxy-only route resolves the name on its far side; a lookup here would leave by this host's network.
  const routes = (await session.resolveProxy(url)).split(';')
  if (!routes.some((route) => route.trim() === 'DIRECT')) {
    return
  }
  const { endpoints } = await session.resolveHost(hostname)
  if (endpoints.length === 0 || endpoints.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('browser_tab_favicon_private_destination')
  }
}

/** Fetches on the page's guest session so an SSH-routed tab's icon request leaves by its route, never this desktop's. */
export function electronBrowserTabFaviconFetch(
  browserPageId: string
): ((url: string, init: RequestInit) => Promise<Response>) | null {
  const guestId = browserManager.getGuestWebContentsId(browserPageId)
  const guest = guestId === null ? undefined : webContents.fromId(guestId)
  if (!guest || guest.isDestroyed()) {
    return null
  }
  const { session } = guest
  return async (url, init) => {
    await assertPublicDestination(session, url)
    return fetchWithElectronManualRedirects(url, init, session)
  }
}
