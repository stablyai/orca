import type { Event, Session, WebContents } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import {
  browserRoutePageKey,
  isValidBrowserRoutePageIdentity,
  type BrowserRoutePageAuthorityRetirement,
  type BrowserRoutePageGuestIdentity,
  type BrowserRoutePageIdentity
} from './browser-route-page-authority'

const DEFAULT_MAX_GUESTS = 256

type BrowserRouteWebContentsRegistryDependencies = {
  getPartitionForSession(session: Session): string | null
  getPreparedPageAuthority(input: BrowserRoutePageIdentity): symbol | null
  maxGuests?: number
}

type GuestState = {
  guest: WebContents
  partition: string
  registration: BrowserRoutePageGuestIdentity | null
  pageAuthority: symbol | null
  navigationGranted: boolean
  retirementCallback: (() => void) | null
  onNavigate: (event: Event, url: string) => void
  onDestroyed: () => void
}

export class BrowserRouteWebContentsRegistry {
  private readonly maxGuests: number
  private readonly guests = new Map<number, GuestState>()
  private readonly guestsByPage = new Map<string, GuestState>()

  constructor(private readonly dependencies: BrowserRouteWebContentsRegistryDependencies) {
    this.maxGuests = dependencies.maxGuests ?? DEFAULT_MAX_GUESTS
  }

  attachGuest(guest: WebContents): boolean {
    let partition: string | null
    try {
      partition = this.dependencies.getPartitionForSession(guest.session)
    } catch {
      destroyGuest(guest)
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
      destroyGuest(guest)
      return false
    }
    let isValid = false
    try {
      isValid = isValidBlankRouteGuest(guest)
    } catch {
      // Electron may destroy a guest between did-attach and main inspection.
    }
    if (existing || this.guests.size >= this.maxGuests || !isValid) {
      destroyGuest(guest)
      if (isDestroyed(guest)) {
        this.releaseGuest(state)
      }
      return false
    }

    this.guests.set(guest.id, state)
    return true
  }

  registerGuest(registration: BrowserRoutePageGuestIdentity): boolean {
    if (!isValidRegistration(registration)) {
      return false
    }
    const state = this.guests.get(registration.webContentsId)
    if (
      !state ||
      !isBlankGuest(state.guest) ||
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
    if (!isValidRegistration(registration)) {
      return false
    }
    const state = this.guests.get(registration.webContentsId)
    if (
      !state?.registration ||
      browserRoutePageKey(state.registration) !== browserRoutePageKey(registration) ||
      !isBlankGuest(state.guest) ||
      !this.registrationMatchesGuest(state, registration) ||
      !this.hasLivePageAuthority(state)
    ) {
      return false
    }
    state.navigationGranted = true
    return true
  }

  retirePageAuthority(retirement: BrowserRoutePageAuthorityRetirement): boolean {
    if (!isValidPageRetirement(retirement)) {
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
    state.retirementCallback = retirement.onRetired
    this.revokeGuest(state)
    return isDestroyed(state.guest)
  }

  private createGuestState(guest: WebContents, partition: string): GuestState {
    const state: GuestState = {
      guest,
      partition,
      registration: null,
      pageAuthority: null,
      navigationGranted: false,
      retirementCallback: null,
      onNavigate: (event, url) => {
        if (!this.navigationAllowed(state, url)) {
          event.preventDefault()
        }
      },
      onDestroyed: () => this.releaseGuest(state)
    }
    return state
  }

  private installGuestQuarantine(state: GuestState): void {
    state.guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    state.guest.on('will-navigate', state.onNavigate)
    state.guest.on('will-redirect', state.onNavigate)
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
      !state.retirementCallback &&
      state.registration &&
      state.pageAuthority !== null &&
      this.dependencies.getPreparedPageAuthority(state.registration) === state.pageAuthority
    )
  }

  private revokeGuest(state: GuestState): void {
    state.navigationGranted = false
    destroyGuest(state.guest)
    if (isDestroyed(state.guest)) {
      this.releaseGuest(state)
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

function isValidBlankRouteGuest(guest: WebContents): boolean {
  return (
    !guest.isDestroyed() &&
    guest.getType() === 'webview' &&
    Number.isInteger(guest.id) &&
    guest.id > 0 &&
    Number.isInteger(guest.hostWebContents?.id) &&
    (guest.hostWebContents?.id ?? 0) > 0 &&
    isBlankGuest(guest)
  )
}

function isBlankGuest(guest: WebContents): boolean {
  try {
    return normalizeBrowserNavigationUrl(guest.getURL()) === ORCA_BROWSER_BLANK_URL
  } catch {
    return false
  }
}

function isValidRegistration(value: BrowserRoutePageGuestIdentity): boolean {
  return Boolean(
    isValidBrowserRoutePageIdentity(value) &&
    Number.isInteger(value.webContentsId) &&
    value.webContentsId > 0 &&
    Number.isInteger(value.rendererWebContentsId) &&
    value.rendererWebContentsId > 0
  )
}

function isValidPageRetirement(value: BrowserRoutePageAuthorityRetirement): boolean {
  return Boolean(
    isValidBrowserRoutePageIdentity(value) &&
    typeof value.pageAuthority === 'symbol' &&
    typeof value.onRetired === 'function'
  )
}

function destroyGuest(guest: WebContents): void {
  try {
    if (guest.isDestroyed()) {
      return
    }
    guest.close()
  } catch {
    // The route remains unavailable even if Electron races guest destruction.
  }
}

function isDestroyed(guest: WebContents): boolean {
  try {
    return guest.isDestroyed()
  } catch {
    return false
  }
}
