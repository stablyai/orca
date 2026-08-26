import {
  browserRoutePageKey,
  type BrowserRouteGuestLifecycleClaim,
  type BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import { isValidRoutePageRegistration } from './browser-route-guest-guard'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'

type BrowserRouteNavigationAuthorityInput = {
  registration: BrowserRoutePageGuestIdentity
  state: BrowserRouteGuestState | undefined
  registrationMatches(): boolean
}

export function grantBrowserRouteGuestNavigation(
  input: BrowserRouteNavigationAuthorityInput & { hasLivePageAuthority(): boolean }
): boolean {
  if (
    !isValidRoutePageRegistration(input.registration) ||
    !input.state?.registration ||
    browserRoutePageKey(input.state.registration) !== browserRoutePageKey(input.registration) ||
    !input.registrationMatches() ||
    !input.hasLivePageAuthority()
  ) {
    return false
  }
  input.state.navigationGranted = true
  return true
}

export function revokeBrowserRouteGuestNavigation(input: {
  claim: BrowserRouteGuestLifecycleClaim
  state: BrowserRouteGuestState | undefined
  registrationMatches(): boolean
}): boolean {
  if (
    !input.state?.registration ||
    input.state.guestAuthority !== input.claim.guestAuthority ||
    browserRoutePageKey(input.state.registration) !==
      browserRoutePageKey(input.claim.registration) ||
    !input.registrationMatches()
  ) {
    return false
  }
  input.state.navigationGranted = false
  // A fenced page keeps no live child window; lease/authority loss reaches popups through here.
  input.state.popups?.closeAll()
  return true
}
