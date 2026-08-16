import type { WebContents } from 'electron'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import {
  isValidBrowserRoutePageIdentity,
  type BrowserRoutePageAuthorityRetirement,
  type BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'

export function isValidBlankRouteGuest(guest: WebContents): boolean {
  return (
    !guest.isDestroyed() &&
    guest.getType() === 'webview' &&
    Number.isInteger(guest.id) &&
    guest.id > 0 &&
    Number.isInteger(guest.hostWebContents?.id) &&
    (guest.hostWebContents?.id ?? 0) > 0 &&
    isBlankRouteGuest(guest)
  )
}

export function isBlankRouteGuest(guest: WebContents): boolean {
  try {
    return normalizeBrowserNavigationUrl(guest.getURL()) === ORCA_BROWSER_BLANK_URL
  } catch {
    return false
  }
}

export function isValidRoutePageRegistration(value: BrowserRoutePageGuestIdentity): boolean {
  return Boolean(
    isValidBrowserRoutePageIdentity(value) &&
    Number.isInteger(value.webContentsId) &&
    value.webContentsId > 0 &&
    Number.isInteger(value.rendererWebContentsId) &&
    value.rendererWebContentsId > 0
  )
}

export function isValidRoutePageRetirement(value: BrowserRoutePageAuthorityRetirement): boolean {
  return Boolean(
    isValidBrowserRoutePageIdentity(value) &&
    typeof value.pageAuthority === 'symbol' &&
    typeof value.onRetired === 'function'
  )
}

export function closeRouteGuest(guest: WebContents): void {
  try {
    if (!guest.isDestroyed()) {
      guest.close()
    }
  } catch {
    // Unknown guest state remains quarantined and unsettled.
  }
}

export function isRouteGuestDestroyed(guest: WebContents): boolean {
  try {
    return guest.isDestroyed()
  } catch {
    return false
  }
}

export function isRouteGuestOwnedByRenderer(
  guest: WebContents,
  registration: BrowserRoutePageGuestIdentity | null,
  rendererWebContentsId: number
): boolean {
  try {
    return (
      registration?.rendererWebContentsId === rendererWebContentsId ||
      guest.hostWebContents?.id === rendererWebContentsId
    )
  } catch {
    return false
  }
}
