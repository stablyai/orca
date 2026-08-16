import type { Event, Session, WebContents } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import {
  browserRoutePageKey,
  type BrowserRoutePageAuthority,
  type BrowserRoutePageAuthorityRetirement,
  type BrowserRoutePageGuestIdentity,
  type BrowserRoutePageIdentity
} from './browser-route-page-authority'
import {
  closeRouteGuest,
  isBlankRouteGuest,
  isRouteGuestDestroyed,
  isRouteGuestOwnedByRenderer,
  isValidBlankRouteGuest,
  isValidRoutePageRegistration,
  isValidRoutePageRetirement
} from './browser-route-guest-guard'

type BrowserRouteWebContentsRegistryDependencies = {
  getPartitionForSession(session: Session): string | null
  getPreparedPageAuthority(input: BrowserRoutePageIdentity): symbol | null
  retirePreparedPage(input: BrowserRoutePageAuthority): boolean
  maxGuests?: number
}

type GuestState = {
  guest: WebContents
  partition: string
  registration: BrowserRoutePageGuestIdentity | null
  pageAuthority: symbol | null
  navigationGranted: boolean
  retirementRequested: boolean
  retirementCallback: (() => void) | null
  onNavigate: (event: Event, url: string) => void
  onRenderProcessGone: () => void
  onDestroyed: () => void
}

export class BrowserRouteWebContentsRegistry {
  private readonly maxGuests: number
  private readonly guests = new Map<number, GuestState>()
  private readonly guestsByPage = new Map<string, GuestState>()

  constructor(private readonly dependencies: BrowserRouteWebContentsRegistryDependencies) {
    this.maxGuests = dependencies.maxGuests ?? 256
  }

  attachGuest(guest: WebContents): boolean {
    let partition: string | null
    try {
      partition = this.dependencies.getPartitionForSession(guest.session)
    } catch {
      closeRouteGuest(guest)
      return false
    }
    if (partition === null) {
      return false
    }
    const existing = this.guests.get(guest.id)
    if (existing?.guest === guest) {
      return true
    }
    const state = this.createGuestState(guest, partition)
    try {
      this.installGuestQuarantine(state)
    } catch {
      closeRouteGuest(guest)
      return false
    }
    let isValid = false
    try {
      isValid = isValidBlankRouteGuest(guest)
    } catch {
      // Electron may destroy a guest between did-attach and main inspection.
    }
    if (existing || this.guests.size >= this.maxGuests || !isValid) {
      closeRouteGuest(guest)
      if (isRouteGuestDestroyed(guest)) {
        this.releaseGuest(state)
      }
      return false
    }

    this.guests.set(guest.id, state)
    return true
  }

  registerGuest(registration: BrowserRoutePageGuestIdentity): boolean {
    if (!isValidRoutePageRegistration(registration)) {
      return false
    }
    const state = this.guests.get(registration.webContentsId)
    if (
      !state ||
      !isBlankRouteGuest(state.guest) ||
      !this.registrationMatchesGuest(state, registration)
    ) {
      return false
    }
    const pageAuthority = this.dependencies.getPreparedPageAuthority(registration)
    if (pageAuthority === null) {
      return false
    }
    const pageKey = browserRoutePageKey(registration)
    const existingPage = this.guestsByPage.get(pageKey)
    if (existingPage && existingPage !== state && this.hasLivePageAuthority(existingPage)) {
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
    this.guestsByPage.set(pageKey, state)
    return true
  }

  grantNavigation(registration: BrowserRoutePageGuestIdentity): boolean {
    if (!isValidRoutePageRegistration(registration)) {
      return false
    }
    const state = this.guests.get(registration.webContentsId)
    if (
      !state?.registration ||
      browserRoutePageKey(state.registration) !== browserRoutePageKey(registration) ||
      !isBlankRouteGuest(state.guest) ||
      !this.registrationMatchesGuest(state, registration) ||
      !this.hasLivePageAuthority(state)
    ) {
      return false
    }
    state.navigationGranted = true
    return true
  }

  retirePageAuthority(retirement: BrowserRoutePageAuthorityRetirement): boolean {
    if (!isValidRoutePageRetirement(retirement)) {
      return true
    }
    const state = this.guestsByPage.get(browserRoutePageKey(retirement))
    if (
      !state?.registration ||
      state.pageAuthority !== retirement.pageAuthority ||
      browserRoutePageKey(state.registration) !== browserRoutePageKey(retirement)
    ) {
      return true
    }
    if (state.retirementCallback) {
      return false
    }
    state.retirementRequested = true
    state.retirementCallback = retirement.onRetired
    this.revokeGuest(state)
    return isRouteGuestDestroyed(state.guest)
  }

  retireRenderer(rendererWebContentsId: number): void {
    if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
      return
    }
    for (const state of this.guests.values()) {
      if (isRouteGuestOwnedByRenderer(state.guest, state.registration, rendererWebContentsId)) {
        this.retireGuestPage(state)
      }
    }
  }

  private createGuestState(guest: WebContents, partition: string): GuestState {
    const state: GuestState = {
      guest,
      partition,
      registration: null,
      pageAuthority: null,
      navigationGranted: false,
      retirementRequested: false,
      retirementCallback: null,
      onNavigate: (event, url) => {
        if (!this.navigationAllowed(state, url)) {
          event.preventDefault()
        }
      },
      onRenderProcessGone: () => this.retireGuestPage(state),
      onDestroyed: () => {
        this.retireGuestPage(state)
        this.releaseGuest(state)
      }
    }
    return state
  }

  private installGuestQuarantine(state: GuestState): void {
    state.guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    state.guest.on('will-navigate', state.onNavigate)
    state.guest.on('will-redirect', state.onNavigate)
    state.guest.on('render-process-gone', state.onRenderProcessGone)
    state.guest.on('destroyed', state.onDestroyed)
  }

  private navigationAllowed(state: GuestState, url: string): boolean {
    try {
      const normalized = normalizeBrowserNavigationUrl(url)
      if (normalized === ORCA_BROWSER_BLANK_URL) {
        return true
      }
      return Boolean(
        normalized &&
        !normalized.startsWith('file:') &&
        state.navigationGranted &&
        state.registration &&
        this.registrationMatchesGuest(state, state.registration) &&
        this.hasLivePageAuthority(state)
      )
    } catch {
      return false
    }
  }

  private registrationMatchesGuest(
    state: GuestState,
    registration: BrowserRoutePageGuestIdentity
  ): boolean {
    try {
      const guest = state.guest
      return (
        !guest.isDestroyed() &&
        guest.getType() === 'webview' &&
        guest.id === registration.webContentsId &&
        guest.hostWebContents?.id === registration.rendererWebContentsId &&
        state.partition === registration.partition &&
        this.dependencies.getPartitionForSession(guest.session) === registration.partition
      )
    } catch {
      return false
    }
  }

  private hasLivePageAuthority(state: GuestState): boolean {
    return Boolean(
      !state.retirementRequested &&
      state.registration &&
      state.pageAuthority !== null &&
      this.dependencies.getPreparedPageAuthority(state.registration) === state.pageAuthority
    )
  }

  private revokeGuest(state: GuestState): void {
    state.navigationGranted = false
    closeRouteGuest(state.guest)
    if (isRouteGuestDestroyed(state.guest)) {
      this.releaseGuest(state)
    }
  }

  private retireGuestPage(state: GuestState): void {
    if (state.retirementRequested) {
      return
    }
    state.retirementRequested = true
    state.navigationGranted = false
    const registration = state.registration
    const pageAuthority = state.pageAuthority
    if (!registration || pageAuthority === null) {
      this.revokeGuest(state)
      return
    }
    let started = false
    try {
      started = this.dependencies.retirePreparedPage({
        partition: registration.partition,
        browserPageId: registration.browserPageId,
        pageHostGeneration: registration.pageHostGeneration,
        pageAuthority
      })
    } catch {
      // Exact guest stays revoked even if logical retirement cannot start.
    }
    if (!started) {
      this.revokeGuest(state)
    }
  }

  private releaseGuest(state: GuestState): void {
    if (this.guests.get(state.guest.id) === state) {
      this.guests.delete(state.guest.id)
    }
    if (state.registration) {
      const pageKey = browserRoutePageKey(state.registration)
      if (this.guestsByPage.get(pageKey) === state) {
        this.guestsByPage.delete(pageKey)
      }
    }
    try {
      state.guest.off('will-navigate', state.onNavigate)
    } catch {}
    try {
      state.guest.off('will-redirect', state.onNavigate)
    } catch {}
    try {
      state.guest.off('render-process-gone', state.onRenderProcessGone)
    } catch {}
    try {
      state.guest.off('destroyed', state.onDestroyed)
    } catch {}
    const callback = state.retirementCallback
    state.retirementCallback = null
    if (callback) {
      try {
        callback()
      } catch {}
    }
  }
}
