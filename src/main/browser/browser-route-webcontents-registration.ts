import {
  browserRoutePageKey,
  type BrowserRoutePageGuestIdentity as GuestIdentity,
  type BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'
import { isBlankRouteGuest, isValidRoutePageRegistration } from './browser-route-guest-guard'
import type { BrowserRouteGuestState as GuestState } from './browser-route-webcontents-state'

export function registerBrowserRouteGuest(input: {
  registration: GuestIdentity
  state: GuestState | undefined
  guestsByPage: Map<string, GuestState>
  getPreparedPageAuthority: (page: BrowserRoutePageOwnerIdentity) => symbol | null
  registrationMatchesGuest: (state: GuestState, registration: GuestIdentity) => boolean
  hasLivePageAuthority: (state: GuestState) => boolean
}): boolean {
  const { registration, state } = input
  if (
    !isValidRoutePageRegistration(registration) ||
    !state ||
    state.retirementRequested ||
    !isBlankRouteGuest(state.guest) ||
    !input.registrationMatchesGuest(state, registration)
  ) {
    return false
  }
  const pageAuthority = input.getPreparedPageAuthority(registration)
  if (pageAuthority === null) {
    return false
  }
  const pageKey = browserRoutePageKey(registration)
  const existingPage = input.guestsByPage.get(pageKey)
  if (existingPage && existingPage !== state && input.hasLivePageAuthority(existingPage)) {
    return false
  }
  if (state.registration) {
    return (
      browserRoutePageKey(state.registration) === pageKey && state.pageAuthority === pageAuthority
    )
  }
  if (existingPage && existingPage !== state) {
    existingPage.registration = null
    existingPage.pageAuthority = null
  }
  state.registration = { ...registration }
  state.pageAuthority = pageAuthority
  input.guestsByPage.set(pageKey, state)
  return true
}
