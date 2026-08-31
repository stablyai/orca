import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import type { WebContents } from 'electron'
import {
  browserRoutePageKey,
  type BrowserRouteGuestLifecycleClaim,
  type BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import { isRouteGuestDestroyed, isValidRoutePageRegistration } from './browser-route-guest-guard'
import {
  createBrowserRouteGuestPopupController,
  type BrowserRouteGuestPopupDependencies
} from './browser-route-guest-popups'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'

export function createBrowserRouteGuestState(
  guest: WebContents,
  partition: string,
  callbacks: {
    navigationAllowed: (state: BrowserRouteGuestState, url: string) => boolean
    retire: (state: BrowserRouteGuestState) => void
    release: (state: BrowserRouteGuestState) => void
  }
): BrowserRouteGuestState {
  let resolveDestroyed = (): void => {}
  const whenDestroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve
  })
  const state: BrowserRouteGuestState = {
    guest,
    guestAuthority: Symbol('browser-route-guest'),
    partition,
    registration: null,
    popups: null,
    isNavigationAllowed: (url) => callbacks.navigationAllowed(state, url),
    pageAuthority: null,
    navigationGranted: false,
    retirementRequested: false,
    availabilityLossReported: false,
    retirementCallback: null,
    whenDestroyed,
    resolveDestroyed,
    onNavigate: (event, url) => {
      if (!state.isNavigationAllowed(url)) {
        event.preventDefault()
      }
    },
    onRenderProcessGone: () => callbacks.retire(state),
    onDestroyed: () => {
      callbacks.retire(state)
      callbacks.release(state)
    }
  }
  return state
}

export function installBrowserRouteGuestQuarantine(
  state: BrowserRouteGuestState,
  dependencies: BrowserRouteGuestPopupDependencies
): void {
  // Gesture-gated, same-partition popups: OAuth needs a real child window, and denying every
  // window.open is what stranded those flows. Everything else about the envelope still applies.
  const popups = createBrowserRouteGuestPopupController({
    opener: state.guest,
    partition: state.partition,
    isNavigationAllowed: (url) => state.isNavigationAllowed(url),
    dependencies
  })
  state.popups = popups
  state.guest.setWindowOpenHandler(popups.windowOpenHandler)
  state.guest.on('will-navigate', state.onNavigate)
  state.guest.on('will-redirect', state.onNavigate)
  state.guest.on('render-process-gone', state.onRenderProcessGone)
  state.guest.on('destroyed', state.onDestroyed)
}

export function isBrowserRouteGuestNavigationAllowed(
  state: BrowserRouteGuestState,
  rawUrl: string,
  isCurrent: () => boolean
): boolean {
  try {
    const normalized = normalizeBrowserNavigationUrl(rawUrl)
    return (
      normalized === ORCA_BROWSER_BLANK_URL ||
      Boolean(
        normalized &&
        !normalized.startsWith('file:') &&
        state.navigationGranted &&
        state.registration &&
        isCurrent()
      )
    )
  } catch {
    return false
  }
}

export async function navigateBrowserRouteGuest(
  registration: BrowserRoutePageGuestIdentity,
  rawUrl: string,
  state: BrowserRouteGuestState | undefined,
  isCurrent: () => boolean
): Promise<boolean> {
  const normalized = normalizeBrowserNavigationUrl(rawUrl)
  if (
    !isValidRoutePageRegistration(registration) ||
    !state?.registration ||
    !normalized ||
    normalized.startsWith('file:') ||
    !state.navigationGranted ||
    browserRoutePageKey(state.registration) !== browserRoutePageKey(registration) ||
    !isCurrent()
  ) {
    return false
  }
  try {
    await state.guest.loadURL(normalized)
    return true
  } catch {
    return false
  }
}

export function beginBrowserRouteGuestRetirement(input: {
  claim: BrowserRouteGuestLifecycleClaim
  state: BrowserRouteGuestState | undefined
  registrationMatches: () => boolean
  hasPreparedAuthority: () => boolean
  retireRegistered: (state: BrowserRouteGuestState) => void
  revokeUnregistered: (state: BrowserRouteGuestState) => void
}): Promise<void> | null {
  if (!input.state || input.state.guestAuthority !== input.claim.guestAuthority) {
    return input.claim.whenDestroyed
  }
  return retireBrowserRouteGuest({
    ...input,
    registration: input.claim.registration
  }) === 'rejected'
    ? null
    : input.state.whenDestroyed
}

export function retireBrowserRouteGuest(input: {
  registration: BrowserRoutePageGuestIdentity
  state: BrowserRouteGuestState | undefined
  registrationMatches: () => boolean
  hasPreparedAuthority: () => boolean
  retireRegistered: (state: BrowserRouteGuestState) => void
  revokeUnregistered: (state: BrowserRouteGuestState) => void
}): 'rejected' | 'retiring' | 'retired' {
  if (
    !isValidRoutePageRegistration(input.registration) ||
    !input.state ||
    !input.registrationMatches()
  ) {
    return 'rejected'
  }
  if (input.state.registration) {
    if (browserRoutePageKey(input.state.registration) !== browserRoutePageKey(input.registration)) {
      return 'rejected'
    }
    input.retireRegistered(input.state)
  } else {
    if (!input.hasPreparedAuthority()) {
      return 'rejected'
    }
    input.state.retirementRequested = true
    input.revokeUnregistered(input.state)
  }
  return isRouteGuestDestroyed(input.state.guest) ? 'retired' : 'retiring'
}
