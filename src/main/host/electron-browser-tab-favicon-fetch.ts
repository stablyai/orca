import { isIP } from 'node:net'
import { webContents, type Session } from 'electron'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { isBlockedAddress, isBlockedHost } from '../link-preview/link-preview-address-guard'
import { fetchWithPinnedAddresses, type PinnedEndpoint } from './pinned-address-fetch'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'

/** Returns the validated addresses a direct route must connect to, or null when the route resolves the name itself. */
async function resolvePublicDestination(
  session: Session,
  url: string
): Promise<PinnedEndpoint[] | null> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (isBlockedHost(hostname)) {
    throw new Error('browser_tab_favicon_private_destination')
  }
  if (isIP(hostname) !== 0) {
    return null
  }
  // Proxy lists are ordered: a leading proxy resolves the name on its far side, so only a leading DIRECT is pinned here.
  const [firstRoute] = (await session.resolveProxy(url)).split(';')
  if (firstRoute.trim() !== 'DIRECT') {
    return null
  }
  const { endpoints } = await session.resolveHost(hostname)
  if (endpoints.length === 0 || endpoints.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('browser_tab_favicon_private_destination')
  }
  return endpoints
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
    const pinned = await resolvePublicDestination(session, url)
    // Connecting to the validated addresses closes the window where a rebinding name resolves again.
    return pinned
      ? fetchWithPinnedAddresses(url, init, pinned)
      : fetchWithElectronManualRedirects(url, init, session)
  }
}
