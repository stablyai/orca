import type { Event, Session, WebContents } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'

const DEFAULT_MAX_GUESTS = 256
const MAX_PAGE_ID_LENGTH = 256
const MAX_PAGE_HOST_GENERATION = 0xffff_ffff

export type BrowserRoutePageGuestIdentity = Readonly<{
  partition: string
  browserPageId: string
  pageHostGeneration: number
  webContentsId: number
  rendererWebContentsId: number
}>

type BrowserRoutePageIdentity = Pick<
  BrowserRoutePageGuestIdentity,
  'partition' | 'browserPageId' | 'pageHostGeneration'
>

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
    const pageKey = routePageKey(registration)
    const existingPage = this.guestsByPage.get(pageKey)
    if (existingPage && existingPage !== state && this.hasLivePageAuthority(existingPage)) {
      return false
    }
    if (state.registration) {
      return routePageKey(state.registration) === pageKey && state.pageAuthority === pageAuthority
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
      routePageKey(state.registration) !== routePageKey(registration) ||
      !isBlankGuest(state.guest) ||
      !this.registrationMatchesGuest(state, registration) ||
      !this.hasLivePageAuthority(state)
    ) {
      return false
    }
    state.navigationGranted = true
    return true
  }

  private createGuestState(guest: WebContents, partition: string): GuestState {
    const state: GuestState = {
      guest,
      partition,
      registration: null,
      pageAuthority: null,
      navigationGranted: false,
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
      state.registration &&
      state.pageAuthority !== null &&
      this.dependencies.getPreparedPageAuthority(state.registration) === state.pageAuthority
    )
  }

  private releaseGuest(state: GuestState): void {
    if (this.guests.get(state.guest.id) === state) {
      this.guests.delete(state.guest.id)
    }
    if (state.registration) {
      const pageKey = routePageKey(state.registration)
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
    value &&
    typeof value.partition === 'string' &&
    typeof value.browserPageId === 'string' &&
    value.browserPageId.length > 0 &&
    value.browserPageId.length <= MAX_PAGE_ID_LENGTH &&
    Number.isInteger(value.pageHostGeneration) &&
    value.pageHostGeneration > 0 &&
    value.pageHostGeneration <= MAX_PAGE_HOST_GENERATION &&
    Number.isInteger(value.webContentsId) &&
    value.webContentsId > 0 &&
    Number.isInteger(value.rendererWebContentsId) &&
    value.rendererWebContentsId > 0
  )
}

function routePageKey(page: BrowserRoutePageIdentity): string {
  return JSON.stringify([page.partition, page.browserPageId, page.pageHostGeneration])
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
    return true
  }
}
