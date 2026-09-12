import {
  browserRoutePageKey,
  type BrowserRouteGuestLifecycleClaim,
  type BrowserRoutePageAuthority,
  type BrowserRoutePageGuestIdentity as GuestIdentity,
  type BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'
import { isValidRoutePageRegistration } from './browser-route-guest-guard'
import type {
  BrowserRouteSessionHandle,
  BrowserRouteSessionRekey
} from './browser-route-session-state'
import type { BrowserRouteGuestState as GuestState } from './browser-route-webcontents-state'

type BrowserRouteGuestRekeyDependencies = {
  rekeyPreparedPage?(
    previous: BrowserRoutePageAuthority,
    next: BrowserRoutePageOwnerIdentity
  ): BrowserRouteSessionRekey | null
}

export type BrowserRouteGuestLifecycleRekey = {
  lifecycleClaim: BrowserRouteGuestLifecycleClaim
  routeSession: BrowserRouteSessionHandle
}

export function rekeyBrowserRouteGuest(input: {
  claim: BrowserRouteGuestLifecycleClaim
  next: GuestIdentity
  state: GuestState | undefined
  guestsByPage: Map<string, GuestState>
  dependencies: BrowserRouteGuestRekeyDependencies
  registrationMatchesGuest: (state: GuestState, registration: GuestIdentity) => boolean
  claimGuestLifecycle: (registration: GuestIdentity) => BrowserRouteGuestLifecycleClaim | null
}): BrowserRouteGuestLifecycleRekey | null {
  const { claim, next, state } = input
  const previous = claim.registration
  if (
    !state?.registration ||
    state.guestAuthority !== claim.guestAuthority ||
    state.retirementRequested ||
    state.navigationGranted ||
    state.pageAuthority === null ||
    !isValidRoutePageRegistration(next) ||
    next.partition !== previous.partition ||
    next.browserPageId !== previous.browserPageId ||
    next.rendererWebContentsId !== previous.rendererWebContentsId ||
    next.webContentsId !== previous.webContentsId ||
    next.pageHostGeneration === previous.pageHostGeneration ||
    browserRoutePageKey(state.registration) !== browserRoutePageKey(previous) ||
    !input.registrationMatchesGuest(state, previous)
  ) {
    return null
  }
  const nextKey = browserRoutePageKey(next)
  const conflicting = input.guestsByPage.get(nextKey)
  const rekeyPreparedPage = input.dependencies.rekeyPreparedPage
  if ((conflicting && conflicting !== state) || !rekeyPreparedPage) {
    return null
  }
  const previousAuthority = { ...previous, pageAuthority: state.pageAuthority }
  const rekeyed = rekeyPreparedPage(previousAuthority, next)
  if (
    !rekeyed ||
    rekeyed.page.pageAuthority !== state.pageAuthority ||
    rekeyed.routeSession.partition !== next.partition ||
    browserRoutePageKey(rekeyed.page) !== nextKey ||
    rekeyed.page.rendererWebContentsId !== next.rendererWebContentsId
  ) {
    if (rekeyed) {
      rekeyPreparedPage(rekeyed.page, previous)
    }
    return null
  }
  const previousKey = browserRoutePageKey(previous)
  input.guestsByPage.delete(previousKey)
  state.registration = { ...next }
  state.pageAuthority = rekeyed.page.pageAuthority
  input.guestsByPage.set(nextKey, state)
  const lifecycleClaim = input.claimGuestLifecycle(next)
  if (!lifecycleClaim) {
    input.guestsByPage.delete(nextKey)
    state.registration = { ...previous }
    state.pageAuthority = previousAuthority.pageAuthority
    input.guestsByPage.set(previousKey, state)
    rekeyPreparedPage(rekeyed.page, previous)
    return null
  }
  return { lifecycleClaim, routeSession: rekeyed.routeSession }
}

export function grantReconciledBrowserRouteGuestNavigation(input: {
  claim: BrowserRouteGuestLifecycleClaim
  state: GuestState | undefined
  registrationMatchesGuest: (state: GuestState, registration: GuestIdentity) => boolean
  hasLivePageAuthority: (state: GuestState) => boolean
}): boolean {
  const { claim, state } = input
  const registration = claim.registration
  if (
    !state?.registration ||
    state.guestAuthority !== claim.guestAuthority ||
    browserRoutePageKey(state.registration) !== browserRoutePageKey(registration) ||
    !input.registrationMatchesGuest(state, registration) ||
    !input.hasLivePageAuthority(state)
  ) {
    return false
  }
  state.navigationGranted = true
  return true
}
