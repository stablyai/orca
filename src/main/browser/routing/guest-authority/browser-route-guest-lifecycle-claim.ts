import {
  browserRoutePageKey,
  type BrowserRouteGuestLifecycleClaim,
  type BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import { isValidRoutePageRegistration } from './browser-route-guest-guard'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'

export function claimBrowserRouteGuestLifecycle(
  registration: BrowserRoutePageGuestIdentity,
  state: BrowserRouteGuestState | undefined,
  registrationMatches: () => boolean
): BrowserRouteGuestLifecycleClaim | null {
  if (
    !isValidRoutePageRegistration(registration) ||
    !state ||
    state.retirementRequested ||
    !registrationMatches() ||
    (state.registration &&
      browserRoutePageKey(state.registration) !== browserRoutePageKey(registration))
  ) {
    return null
  }
  return Object.freeze({
    registration: Object.freeze({ ...registration }),
    guestAuthority: state.guestAuthority,
    whenDestroyed: state.whenDestroyed,
    isCurrent: () => !state.retirementRequested && registrationMatches()
  })
}

export function claimRegisteredBrowserRouteGuestLifecycle(
  registration: BrowserRoutePageGuestIdentity,
  state: BrowserRouteGuestState | undefined,
  registrationMatches: (state: BrowserRouteGuestState) => boolean,
  hasAuthority: (state: BrowserRouteGuestState) => boolean
): BrowserRouteGuestLifecycleClaim | null {
  return claimBrowserRouteGuestLifecycle(registration, state, () =>
    Boolean(
      state &&
      (!state.registration ||
        (browserRoutePageKey(state.registration) === browserRoutePageKey(registration) &&
          hasAuthority(state))) &&
      registrationMatches(state)
    )
  )
}
