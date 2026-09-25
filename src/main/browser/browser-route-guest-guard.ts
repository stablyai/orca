import type { Session, WebContents } from 'electron'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import {
  isValidBrowserRoutePageOwnerIdentity,
  type BrowserRoutePageAuthorityRetirement,
  type BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'

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
    isValidBrowserRoutePageOwnerIdentity(value) &&
    Number.isInteger(value.webContentsId) &&
    value.webContentsId > 0
  )
}

export function isValidRoutePageRetirement(value: BrowserRoutePageAuthorityRetirement): boolean {
  return Boolean(
    isValidBrowserRoutePageOwnerIdentity(value) &&
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

export function browserRouteRegistrationMatchesGuest(
  state: BrowserRouteGuestState,
  registration: BrowserRoutePageGuestIdentity,
  getPartitionForSession: (session: Session) => string | null
): boolean {
  try {
    const guest = state.guest
    return (
      !guest.isDestroyed() &&
      guest.getType() === 'webview' &&
      guest.id === registration.webContentsId &&
      guest.hostWebContents?.id === registration.rendererWebContentsId &&
      state.partition === registration.partition &&
      getPartitionForSession(guest.session) === registration.partition
    )
  } catch {
    return false
  }
}
