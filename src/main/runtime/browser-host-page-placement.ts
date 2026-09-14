import type {
  RuntimeBrowserClientPlacement,
  RuntimeBrowserPlacement,
  RuntimeBrowserServerPlacement
} from '../../shared/runtime-browser-placement'
import {
  assertBrowserHostPlacementIdentity,
  assertBrowserPageGeneration,
  assertBrowserPageIdentity,
  MAX_BROWSER_PAGE_GENERATION,
  type BrowserHostPlacementIdentity
} from './browser-host-page-placement-validation'

export type {
  RuntimeBrowserClientPlacement,
  RuntimeBrowserPlacement,
  RuntimeBrowserServerPlacement
} from '../../shared/runtime-browser-placement'

const DEFAULT_MAX_PAGE_PLACEMENTS = 256

export type BrowserPageRetirement = Readonly<{
  browserPageId: string
  placement: RuntimeBrowserPlacement
}>
export type BrowserClientPagePlacementReservation = Readonly<{
  browserPageId: string
  placement: RuntimeBrowserClientPlacement
}>

export type BrowserClientPageAuthority = Readonly<{
  authorityRuntimeId: string
  authorityEpoch: string
  browserPageId: string
  browserHostClientId: string
  browserHostGeneration: number
  pageHostGeneration: number
}>

type BrowserPagePlacementState = {
  placement: RuntimeBrowserPlacement
  retirement?: BrowserPageRetirement
  retirementTerminal?: boolean
  retirementCompletionInProgress?: boolean
}

export class BrowserHostPagePlacementRegistry {
  private nextPageGeneration = 1
  private readonly placementsByPageId = new Map<string, BrowserPagePlacementState>()
  private readonly reservationsByPageId = new Map<string, BrowserClientPagePlacementReservation>()
  private readonly reservationSlotClaims = new Set<BrowserClientPagePlacementReservation>()
  private reservedPlacementSlots = 0
  private readonly maxPagePlacements: number

  constructor(
    private readonly authority: { authorityRuntimeId: string; authorityEpoch: string },
    options?: { maxPagePlacements?: number }
  ) {
    this.maxPagePlacements = options?.maxPagePlacements ?? DEFAULT_MAX_PAGE_PLACEMENTS
  }

  placeServerPage(browserPageId: string): RuntimeBrowserServerPlacement {
    this.assertPlacementAdmission(browserPageId)
    const placement = Object.freeze({ kind: 'server' as const })
    this.placementsByPageId.set(browserPageId, { placement })
    return placement
  }

  placeClientPage(
    browserPageId: string,
    host: BrowserHostPlacementIdentity
  ): RuntimeBrowserClientPlacement {
    this.assertPlacementAdmission(browserPageId)
    assertBrowserHostPlacementIdentity(host)
    const placement = Object.freeze({
      kind: 'client' as const,
      browserHostClientId: host.browserHostClientId,
      browserHostGeneration: host.browserHostGeneration,
      pageHostGeneration: this.takePageGeneration()
    })
    this.placementsByPageId.set(browserPageId, { placement })
    return placement
  }

  reserveClientPage(
    browserPageId: string,
    host: BrowserHostPlacementIdentity,
    pageHostGeneration: number
  ): BrowserClientPagePlacementReservation {
    assertBrowserPageIdentity(browserPageId)
    assertBrowserHostPlacementIdentity(host)
    assertBrowserPageGeneration(pageHostGeneration)
    if (this.reservationsByPageId.has(browserPageId)) {
      throw new Error('browser_page_reconciliation_reservation_pending')
    }
    const claimsPlacementSlot = !this.placementsByPageId.has(browserPageId)
    if (
      claimsPlacementSlot &&
      this.placementsByPageId.size + this.reservedPlacementSlots >= this.maxPagePlacements
    ) {
      throw new Error('browser_page_placement_capacity')
    }
    if (pageHostGeneration < this.nextPageGeneration) {
      throw new Error('browser_page_generation_stale')
    }
    this.nextPageGeneration = pageHostGeneration + 1
    const reservation = Object.freeze({
      browserPageId,
      placement: Object.freeze({
        kind: 'client' as const,
        browserHostClientId: host.browserHostClientId,
        browserHostGeneration: host.browserHostGeneration,
        pageHostGeneration
      })
    })
    this.reservationsByPageId.set(browserPageId, reservation)
    if (claimsPlacementSlot) {
      this.claimReservationSlot(reservation)
    }
    return reservation
  }

  reserveNewClientPage(
    browserPageId: string,
    host: BrowserHostPlacementIdentity
  ): BrowserClientPagePlacementReservation {
    return this.reserveClientPage(browserPageId, host, this.nextPageGeneration)
  }

  commitClientPageReservation(
    reservation: BrowserClientPagePlacementReservation
  ): RuntimeBrowserClientPlacement {
    if (this.reservationsByPageId.get(reservation.browserPageId) !== reservation) {
      throw new Error('browser_page_reconciliation_reservation_stale')
    }
    if (this.placementsByPageId.has(reservation.browserPageId)) {
      throw new Error('browser_page_replacement_requires_retirement')
    }
    this.reservationsByPageId.delete(reservation.browserPageId)
    this.releaseReservationSlot(reservation)
    this.placementsByPageId.set(reservation.browserPageId, {
      placement: reservation.placement
    })
    return reservation.placement
  }

  cancelClientPageReservation(reservation: BrowserClientPagePlacementReservation): boolean {
    if (this.reservationsByPageId.get(reservation.browserPageId) !== reservation) {
      return false
    }
    this.reservationsByPageId.delete(reservation.browserPageId)
    this.releaseReservationSlot(reservation)
    return true
  }

  requireClientPage(authority: BrowserClientPageAuthority): RuntimeBrowserClientPlacement {
    const state = this.placementsByPageId.get(authority.browserPageId)
    const placement = state?.placement
    if (placement?.kind !== 'client') {
      throw new Error('browser_client_page_placement_required')
    }
    if (
      authority.authorityRuntimeId !== this.authority.authorityRuntimeId ||
      authority.authorityEpoch !== this.authority.authorityEpoch ||
      authority.browserHostClientId !== placement.browserHostClientId ||
      authority.browserHostGeneration !== placement.browserHostGeneration ||
      authority.pageHostGeneration !== placement.pageHostGeneration
    ) {
      throw new Error('browser_page_placement_stale')
    }
    if (state?.retirement) {
      throw new Error('browser_page_retirement_pending')
    }
    return placement
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.placementsByPageId.get(browserPageId)?.placement
  }

  beginPageRetirement(
    browserPageId: string,
    expected: RuntimeBrowserPlacement
  ): BrowserPageRetirement {
    const state = this.placementsByPageId.get(browserPageId)
    if (state?.placement !== expected) {
      throw new Error('browser_page_placement_stale')
    }
    if (state.retirement) {
      return state.retirement
    }
    const retirement = Object.freeze({ browserPageId, placement: expected })
    state.retirement = retirement
    return retirement
  }

  /** Returns each fenced page's retirement, so the caller can complete what the client never will. */
  fenceClientHostPlacements(host: BrowserHostPlacementIdentity): BrowserPageRetirement[] {
    assertBrowserHostPlacementIdentity(host)
    const fenced: BrowserPageRetirement[] = []
    for (const [browserPageId, state] of this.placementsByPageId) {
      const placement = state.placement
      if (
        placement.kind !== 'client' ||
        placement.browserHostClientId !== host.browserHostClientId ||
        placement.browserHostGeneration !== host.browserHostGeneration
      ) {
        continue
      }
      state.retirement ??= Object.freeze({ browserPageId, placement })
      state.retirementTerminal = true
      // A completion already running owns the delete; completing again would throw.
      if (!state.retirementCompletionInProgress) {
        fenced.push(state.retirement)
      }
    }
    return fenced
  }

  cancelPageRetirement(retirement: BrowserPageRetirement): boolean {
    const state = this.placementsByPageId.get(retirement.browserPageId)
    if (
      state?.retirement !== retirement ||
      state.retirementTerminal ||
      state.retirementCompletionInProgress
    ) {
      return false
    }
    state.retirement = undefined
    state.retirementTerminal = undefined
    return true
  }

  completePageRetirement(retirement: BrowserPageRetirement, beforeComplete?: () => void): boolean {
    const state = this.placementsByPageId.get(retirement.browserPageId)
    if (state?.retirement !== retirement) {
      return false
    }
    if (state.retirementCompletionInProgress) {
      throw new Error('browser_page_retirement_completion_pending')
    }
    state.retirementCompletionInProgress = true
    try {
      beforeComplete?.()
      const reservation = this.reservationsByPageId.get(retirement.browserPageId)
      if (reservation) {
        this.claimReservationSlot(reservation)
      }
      return this.placementsByPageId.delete(retirement.browserPageId)
    } finally {
      state.retirementCompletionInProgress = false
    }
  }

  assertPlacementAdmission(browserPageId: string): void {
    assertBrowserPageIdentity(browserPageId)
    if (
      this.placementsByPageId.has(browserPageId) ||
      this.reservationsByPageId.has(browserPageId)
    ) {
      throw new Error('browser_page_replacement_requires_retirement')
    }
    if (this.placementsByPageId.size + this.reservedPlacementSlots >= this.maxPagePlacements) {
      throw new Error('browser_page_placement_capacity')
    }
  }

  private takePageGeneration(): number {
    const value = this.nextPageGeneration
    if (value > MAX_BROWSER_PAGE_GENERATION) {
      throw new Error('browser_page_generation_exhausted')
    }
    this.nextPageGeneration += 1
    return value
  }

  private claimReservationSlot(reservation: BrowserClientPagePlacementReservation): void {
    if (!this.reservationSlotClaims.has(reservation)) {
      this.reservationSlotClaims.add(reservation)
      this.reservedPlacementSlots += 1
    }
  }

  private releaseReservationSlot(reservation: BrowserClientPagePlacementReservation): void {
    if (this.reservationSlotClaims.delete(reservation)) {
      this.reservedPlacementSlots -= 1
    }
  }
}
