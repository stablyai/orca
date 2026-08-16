const MAX_GENERATION = 0xffff_ffff
const MAX_IDENTITY_LENGTH = 256
const DEFAULT_MAX_PAGE_PLACEMENTS = 256

export type RuntimeBrowserServerPlacement = { kind: 'server' }
export type RuntimeBrowserClientPlacement = {
  kind: 'client'
  browserHostClientId: string
  browserHostGeneration: number
  pageHostGeneration: number
}
export type RuntimeBrowserPlacement = RuntimeBrowserServerPlacement | RuntimeBrowserClientPlacement

export type BrowserClientPageAuthority = Readonly<{
  authorityRuntimeId: string
  authorityEpoch: string
  browserPageId: string
  browserHostClientId: string
  browserHostGeneration: number
  pageHostGeneration: number
}>

type BrowserHostPlacementIdentity = Readonly<{
  browserHostClientId: string
  browserHostGeneration: number
}>

export class BrowserHostPagePlacementRegistry {
  private nextPageGeneration = 1
  private readonly placementsByPageId = new Map<string, RuntimeBrowserPlacement>()
  private readonly maxPagePlacements: number

  constructor(
    private readonly authority: { authorityRuntimeId: string; authorityEpoch: string },
    options?: { maxPagePlacements?: number }
  ) {
    this.maxPagePlacements = options?.maxPagePlacements ?? DEFAULT_MAX_PAGE_PLACEMENTS
  }

  placeServerPage(browserPageId: string): RuntimeBrowserServerPlacement {
    this.assertAdmission(browserPageId)
    const placement = Object.freeze({ kind: 'server' as const })
    this.placementsByPageId.set(browserPageId, placement)
    return placement
  }

  placeClientPage(
    browserPageId: string,
    host: BrowserHostPlacementIdentity
  ): RuntimeBrowserClientPlacement {
    this.assertAdmission(browserPageId)
    assertBrowserHostPlacementIdentity(host)
    const placement = Object.freeze({
      kind: 'client' as const,
      browserHostClientId: host.browserHostClientId,
      browserHostGeneration: host.browserHostGeneration,
      pageHostGeneration: this.takePageGeneration()
    })
    this.placementsByPageId.set(browserPageId, placement)
    return placement
  }

  requireClientPage(authority: BrowserClientPageAuthority): RuntimeBrowserClientPlacement {
    const placement = this.placementsByPageId.get(authority.browserPageId)
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
    return placement
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.placementsByPageId.get(browserPageId)
  }

  retirePage(browserPageId: string, expected: RuntimeBrowserPlacement): boolean {
    if (this.placementsByPageId.get(browserPageId) !== expected) {
      return false
    }
    return this.placementsByPageId.delete(browserPageId)
  }

  private assertAdmission(browserPageId: string): void {
    if (
      typeof browserPageId !== 'string' ||
      browserPageId.length === 0 ||
      browserPageId.length > MAX_IDENTITY_LENGTH
    ) {
      throw new Error('browser_page_identity_invalid')
    }
    if (
      !this.placementsByPageId.has(browserPageId) &&
      this.placementsByPageId.size >= this.maxPagePlacements
    ) {
      throw new Error('browser_page_placement_capacity')
    }
  }

  private takePageGeneration(): number {
    const value = this.nextPageGeneration
    if (value > MAX_GENERATION) {
      throw new Error('browser_page_generation_exhausted')
    }
    this.nextPageGeneration += 1
    return value
  }
}

function assertBrowserHostPlacementIdentity(host: BrowserHostPlacementIdentity): void {
  if (
    typeof host.browserHostClientId !== 'string' ||
    host.browserHostClientId.length === 0 ||
    host.browserHostClientId.length > MAX_IDENTITY_LENGTH ||
    !Number.isInteger(host.browserHostGeneration) ||
    host.browserHostGeneration < 1 ||
    host.browserHostGeneration > MAX_GENERATION
  ) {
    throw new Error('browser_host_identity_invalid')
  }
}
