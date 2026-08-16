import type { Session, WebContents } from 'electron'
import {
  browserRoutePageKey,
  type BrowserRouteGuestLifecycleClaim,
  type BrowserRoutePageAuthority,
  type BrowserRoutePageAuthorityRetirement,
  type BrowserRoutePageGuestIdentity as GuestIdentity,
  type BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'
import {
  closeRouteGuest,
  isBlankRouteGuest,
  isRouteGuestDestroyed,
  isRouteGuestOwnedByRenderer,
  isValidBlankRouteGuest,
  isValidRoutePageRetirement
} from './browser-route-guest-guard'
import { claimBrowserRouteGuestLifecycle } from './browser-route-guest-lifecycle-claim'
import { releaseBrowserRouteGuest } from './browser-route-guest-release'
import {
  grantBrowserRouteGuestNavigation,
  revokeBrowserRouteGuestNavigation
} from './browser-route-navigation-authority'
import {
  beginBrowserRouteGuestRetirement,
  createBrowserRouteGuestState,
  installBrowserRouteGuestQuarantine,
  isBrowserRouteGuestNavigationAllowed,
  navigateBrowserRouteGuest
} from './browser-route-guest-lifecycle'
import type { BrowserRouteGuestState as GuestState } from './browser-route-webcontents-state'
import type { BrowserRouteSessionRekey } from './browser-route-session-state'
import {
  grantReconciledBrowserRouteGuestNavigation,
  rekeyBrowserRouteGuest,
  type BrowserRouteGuestLifecycleRekey
} from './browser-route-webcontents-rekey'
import { registerBrowserRouteGuest } from './browser-route-webcontents-registration'

type BrowserRouteWebContentsRegistryDependencies = {
  getPartitionForSession(session: Session): string | null
  getPreparedPageAuthority(input: BrowserRoutePageOwnerIdentity): symbol | null
  rekeyPreparedPage?(
    previous: BrowserRoutePageAuthority,
    next: BrowserRoutePageOwnerIdentity
  ): BrowserRouteSessionRekey | null
  retirePreparedPage(input: BrowserRoutePageAuthority): boolean
  retirePreparedPagesOwnedByRenderer(rendererWebContentsId: number): number
  maxGuests?: number
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
      installBrowserRouteGuestQuarantine(state)
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

  registerGuest(registration: GuestIdentity): boolean {
    return registerBrowserRouteGuest({
      registration,
      state: this.guests.get(registration.webContentsId),
      guestsByPage: this.guestsByPage,
      getPreparedPageAuthority: (page) => this.dependencies.getPreparedPageAuthority(page),
      registrationMatchesGuest: (state, page) => this.registrationMatchesGuest(state, page),
      hasLivePageAuthority: (state) => this.hasLivePageAuthority(state)
    })
  }

  claimGuestLifecycle(registration: GuestIdentity): BrowserRouteGuestLifecycleClaim | null {
    const state = this.guests.get(registration.webContentsId)
    return claimBrowserRouteGuestLifecycle(registration, state, () =>
      Boolean(
        state &&
        (!state.registration ||
          (browserRoutePageKey(state.registration) === browserRoutePageKey(registration) &&
            this.hasLivePageAuthority(state))) &&
        this.registrationMatchesGuest(state, registration)
      )
    )
  }

  rekeyGuestLifecycle(
    claim: BrowserRouteGuestLifecycleClaim,
    next: GuestIdentity
  ): BrowserRouteGuestLifecycleRekey | null {
    return rekeyBrowserRouteGuest({
      claim,
      next,
      state: this.guests.get(claim.registration.webContentsId),
      guestsByPage: this.guestsByPage,
      dependencies: this.dependencies,
      registrationMatchesGuest: (state, registration) =>
        this.registrationMatchesGuest(state, registration),
      claimGuestLifecycle: (registration) => this.claimGuestLifecycle(registration)
    })
  }

  grantNavigation(registration: GuestIdentity): boolean {
    const state = this.guests.get(registration.webContentsId)
    return grantBrowserRouteGuestNavigation({
      registration,
      state,
      registrationMatches: () =>
        Boolean(
          state &&
          isBlankRouteGuest(state.guest) &&
          this.registrationMatchesGuest(state, registration)
        ),
      hasLivePageAuthority: () => Boolean(state && this.hasLivePageAuthority(state))
    })
  }

  grantReconciledNavigation(claim: BrowserRouteGuestLifecycleClaim): boolean {
    return grantReconciledBrowserRouteGuestNavigation({
      claim,
      state: this.guests.get(claim.registration.webContentsId),
      registrationMatchesGuest: (state, registration) =>
        this.registrationMatchesGuest(state, registration),
      hasLivePageAuthority: (state) => this.hasLivePageAuthority(state)
    })
  }

  revokeNavigation(claim: BrowserRouteGuestLifecycleClaim): boolean {
    const registration = claim.registration
    const state = this.guests.get(registration.webContentsId)
    return revokeBrowserRouteGuestNavigation({
      claim,
      state,
      registrationMatches: () =>
        Boolean(state && this.registrationMatchesGuest(state, registration))
    })
  }

  async navigateGuest(claim: BrowserRouteGuestLifecycleClaim, rawUrl: string): Promise<boolean> {
    const registration = claim.registration
    const state = this.guests.get(registration.webContentsId)
    const isCurrent = Boolean(
      state &&
      state.guestAuthority === claim.guestAuthority &&
      this.registrationMatchesGuest(state, registration) &&
      this.hasLivePageAuthority(state)
    )
    return navigateBrowserRouteGuest(registration, rawUrl, state, () => isCurrent)
  }

  beginGuestRetirement(claim: BrowserRouteGuestLifecycleClaim): Promise<void> | null {
    const registration = claim.registration
    const state = this.guests.get(registration.webContentsId)
    return beginBrowserRouteGuestRetirement({
      claim,
      state,
      registrationMatches: () =>
        Boolean(state && this.registrationMatchesGuest(state, registration)),
      hasPreparedAuthority: () => this.dependencies.getPreparedPageAuthority(registration) !== null,
      retireRegistered: (guestState) => this.retireGuestPage(guestState),
      revokeUnregistered: (guestState) => this.revokeGuest(guestState)
    })
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
    try {
      this.dependencies.retirePreparedPagesOwnedByRenderer(rendererWebContentsId)
    } catch {
      // Attached guests stay revoked even if logical owner cleanup is unavailable.
    }
  }

  private createGuestState(guest: WebContents, partition: string): GuestState {
    return createBrowserRouteGuestState(guest, partition, {
      navigationAllowed: (state, url) => this.navigationAllowed(state, url),
      retire: (state) => this.retireGuestPage(state),
      release: (state) => this.releaseGuest(state)
    })
  }

  private navigationAllowed(state: GuestState, url: string): boolean {
    return isBrowserRouteGuestNavigationAllowed(state, url, () =>
      Boolean(
        state.registration &&
        this.registrationMatchesGuest(state, state.registration) &&
        this.hasLivePageAuthority(state)
      )
    )
  }

  private registrationMatchesGuest(state: GuestState, registration: GuestIdentity): boolean {
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
        rendererWebContentsId: registration.rendererWebContentsId,
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
    releaseBrowserRouteGuest(state, this.guests, this.guestsByPage)
  }
}
