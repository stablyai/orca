import {
  startBrowserPageAttach,
  waitForBrowserPageReady
} from '../../guest-lifecycle/browser-page-memory'
import type { BrowserRouteWebContentsRegistryDependencies } from './browser-route-webcontents-registry-dependencies'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser/navigation/browser-url'
import '../../../../shared/orca-profiles/constants'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/browser/browser-blank-page'
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
import { whenBrowserExtensionsReadyForPage } from '../../extensions/profile-sessions/browser-extension-page-start'
import { untilAborted } from './browser-route-guest-initialization'

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
  dependencies: BrowserRouteGuestPopupDependencies & {
    isPopupNavigationAllowed: (url: string) => boolean
  }
): void {
  const popups = createBrowserRouteGuestPopupController({
    opener: state.guest,
    partition: state.partition,
    isNavigationAllowed: dependencies.isPopupNavigationAllowed,
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
  isCurrent: () => boolean,
  allowUnregisteredBlank = true
): boolean {
  try {
    const normalized = normalizeBrowserNavigationUrl(rawUrl)
    return (
      (allowUnregisteredBlank && normalized === ORCA_BROWSER_BLANK_URL) ||
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

// Each route navigation's turn, so one that waited for extensions yields to a newer one.
const routeNavigationSequence = new WeakMap<WebContents, number>()

export async function navigateBrowserRouteGuest(
  registration: BrowserRoutePageGuestIdentity,
  rawUrl: string,
  state: BrowserRouteGuestState | undefined,
  isCurrent: () => boolean,
  /** The command's cancellation: it ends the extension wait and blocks the load. */
  signal?: AbortSignal
): Promise<boolean> {
  const normalized = normalizeBrowserNavigationUrl(rawUrl)
  const allowed = (): boolean =>
    Boolean(
      isValidRoutePageRegistration(registration) &&
      state?.registration &&
      normalized &&
      !normalized.startsWith('file:') &&
      state.navigationGranted &&
      browserRoutePageKey(state.registration) === browserRoutePageKey(registration) &&
      !state.guest.isDestroyed() &&
      isCurrent()
    )
  if (!state || !normalized || !allowed()) {
    return false
  }
  const sequence = (routeNavigationSequence.get(state.guest) ?? 0) + 1
  routeNavigationSequence.set(state.guest, sequence)
  try {
    // As in initialization: a route session's first request must not straddle an extension load.
    const extensionsReady = whenBrowserExtensionsReadyForPage(state.guest)
    if (extensionsReady) {
      // A navigation started meanwhile (the user typing an address) is newer than this one.
      let overtaken = false
      const started = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
      ): void => {
        overtaken ||= details.isMainFrame && !details.isSameDocument
      }
      state.guest.on('did-start-navigation', started)
      try {
        await (signal ? untilAborted(extensionsReady, signal) : extensionsReady)
      } finally {
        state.guest.off('did-start-navigation', started)
      }
      // Authority can be revoked or the command cancelled while waiting.
      if (signal?.aborted || !allowed()) {
        return false
      }
      // Superseded by a newer navigation, which owns the page now; page metadata reports its URL.
      if (overtaken || routeNavigationSequence.get(state.guest) !== sequence) {
        return true
      }
    }
    await (startBrowserPageAttach(state.guest, normalized)
      ? waitForBrowserPageReady(registration.browserPageId, state.guest)
      : state.guest.loadURL(normalized))
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

export function retireBrowserRouteGuestPage(
  state: BrowserRouteGuestState,
  dependencies: BrowserRouteWebContentsRegistryDependencies,
  revoke: () => void
): void {
  if (state.retirementRequested) {
    return
  }
  state.retirementRequested = true
  state.navigationGranted = false
  // Fence popups before the logical retirement round trip.
  state.popups?.closeAll()
  const registration = state.registration
  const pageAuthority = state.pageAuthority
  if (!registration || pageAuthority === null) {
    revoke()
    return
  }
  let started = false
  try {
    started = dependencies.retirePreparedPage({
      partition: registration.partition,
      browserPageId: registration.browserPageId,
      pageHostGeneration: registration.pageHostGeneration,
      rendererWebContentsId: registration.rendererWebContentsId,
      pageAuthority
    })
  } catch {
    // Exact guest stays revoked even if logical retirement cannot start.
  }
  if (!started) {
    revoke()
  }
}
