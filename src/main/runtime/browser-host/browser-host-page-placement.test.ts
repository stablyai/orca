import { describe, expect, it } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'

const registry = (): BrowserHostLeaseRegistry =>
  new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a'
  })

const placements = (maxPagePlacements = 256): BrowserHostPagePlacementRegistry =>
  new BrowserHostPagePlacementRegistry(
    { authorityRuntimeId: 'runtime-a', authorityEpoch: 'epoch-a' },
    { maxPagePlacements }
  )

function attachHost(leases: BrowserHostLeaseRegistry, connectionId = 'connection-a') {
  return leases.attach({
    browserHostClientId: 'host-a',
    connectionId,
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview']
  })
}

function pageAuthority(pageHostGeneration: number, browserHostGeneration = 1) {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserPageId: 'page-a',
    browserHostClientId: 'host-a',
    browserHostGeneration,
    pageHostGeneration
  }
}

describe('browser host page placement authority', () => {
  it('requires the exact runtime, epoch, host, and page generation on a live lease', () => {
    const leases = registry()
    attachHost(leases)
    const placement = leases.placeClientPage('page-a', 'host-a')

    expect(leases.requireClientPage(pageAuthority(1))).toBe(placement)
    for (const mismatch of [
      { authorityRuntimeId: 'runtime-b' },
      { authorityEpoch: 'epoch-b' },
      { browserHostClientId: 'host-b' },
      { browserHostGeneration: 2 },
      { pageHostGeneration: 2 }
    ]) {
      expect(() => leases.requireClientPage({ ...pageAuthority(1), ...mismatch })).toThrow(
        'browser_page_placement_stale'
      )
    }
    expect(() =>
      leases.requireClientPage({ ...pageAuthority(1), browserPageId: 'page-b' })
    ).toThrow('browser_client_page_placement_required')
  })

  it('releases the placement when its lease is released or replaced', () => {
    const leases = registry()
    const firstHost = attachHost(leases)
    leases.placeClientPage('page-a', 'host-a')

    firstHost.release()
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow(
      'browser_client_page_placement_required'
    )

    attachHost(leases, 'connection-b')
    const replacement = leases.placeClientPage('page-a', 'host-a')
    expect(leases.requireClientPage(pageAuthority(2, 2))).toBe(replacement)

    attachHost(leases, 'connection-c')
    expect(leases.getPlacement('page-a')).toBeUndefined()
  })

  it('rejects retired, replaced, and server page placements', () => {
    const leases = registry()
    attachHost(leases)
    const first = leases.placeClientPage('page-a', 'host-a')

    const firstRetirement = leases.beginPageRetirement('page-a', first)
    expect(leases.completePageRetirement(firstRetirement)).toBe(true)
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow(
      'browser_client_page_placement_required'
    )
    const replacement = leases.placeClientPage('page-a', 'host-a')
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow('browser_page_placement_stale')
    expect(leases.requireClientPage(pageAuthority(2))).toBe(replacement)

    const replacementRetirement = leases.beginPageRetirement('page-a', replacement)
    expect(leases.completePageRetirement(replacementRetirement)).toBe(true)
    leases.placeServerPage('page-a')
    expect(() => leases.requireClientPage(pageAuthority(2))).toThrow(
      'browser_client_page_placement_required'
    )
  })

  it('bounds live logical placements until exact retirement', () => {
    const pages = placements(1)
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const first = pages.placeClientPage('page-a', host)

    expect(() => pages.placeClientPage('page-b', host)).toThrow('browser_page_placement_capacity')
    expect(() => pages.placeClientPage('page-a', host)).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    const firstRetirement = pages.beginPageRetirement('page-a', first)
    expect(pages.completePageRetirement(firstRetirement)).toBe(true)
    const replacement = pages.placeClientPage('page-a', host)
    expect(replacement).toMatchObject({
      pageHostGeneration: first.pageHostGeneration + 1
    })
    const replacementRetirement = pages.beginPageRetirement('page-a', replacement)
    expect(pages.completePageRetirement(replacementRetirement)).toBe(true)
    expect(pages.placeServerPage('page-b')).toEqual({ kind: 'server' })
  })

  it('enforces the default 256-placement limit and restores admission after retirement', () => {
    const pages = placements()
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const admitted = Array.from({ length: 256 }, (_, index) =>
      pages.placeClientPage(`page-${index}`, host)
    )

    expect(() => pages.placeClientPage('page-overflow', host)).toThrow(
      'browser_page_placement_capacity'
    )
    const firstPlacement = admitted[0]
    if (!firstPlacement) {
      throw new Error('browser_page_test_placement_required')
    }
    const firstRetirement = pages.beginPageRetirement('page-0', firstPlacement)
    expect(pages.completePageRetirement(firstRetirement)).toBe(true)
    expect(pages.placeClientPage('page-overflow', host)).toMatchObject({
      pageHostGeneration: 257
    })
  })

  it('allocates one global page-generation order across page IDs and reuse', () => {
    const pages = placements()
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const first = pages.placeClientPage('page-a', host)
    const second = pages.placeClientPage('page-b', host)
    const retirement = pages.beginPageRetirement('page-a', first)
    expect(pages.completePageRetirement(retirement)).toBe(true)
    const reused = pages.placeClientPage('page-a', host)

    expect([
      first.pageHostGeneration,
      second.pageHostGeneration,
      reused.pageHostGeneration
    ]).toEqual([1, 2, 3])
  })

  it('reserves an exact reconciliation generation without exposing placement', () => {
    const pages = placements()
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const reservation = pages.reserveClientPage('page-a', host, 5)

    expect(pages.getPlacement('page-a')).toBeUndefined()
    expect(() => pages.placeClientPage('page-a', host)).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(pages.commitClientPageReservation(reservation)).toBe(reservation.placement)
    expect(pages.getPlacement('page-a')).toBe(reservation.placement)
    expect(pages.placeClientPage('page-b', host)).toMatchObject({ pageHostGeneration: 6 })

    const cancelled = pages.reserveClientPage('page-c', host, 9)
    expect(pages.cancelClientPageReservation(cancelled)).toBe(true)
    expect(pages.cancelClientPageReservation(cancelled)).toBe(false)
    expect(pages.placeClientPage('page-c', host)).toMatchObject({ pageHostGeneration: 10 })
  })

  it('reserves only missing-page capacity and blocks competing placement admission', () => {
    const pages = placements(2)
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const existing = pages.placeClientPage('page-a', host)
    const replacement = pages.reserveClientPage('page-a', host, 5)
    const missing = pages.reserveClientPage('page-b', host, 6)

    expect(() => pages.placeServerPage('page-c')).toThrow('browser_page_placement_capacity')
    expect(pages.cancelClientPageReservation(missing)).toBe(true)
    expect(pages.placeServerPage('page-c')).toEqual({ kind: 'server' })

    const retirement = pages.beginPageRetirement('page-a', existing)
    expect(pages.completePageRetirement(retirement)).toBe(true)
    expect(pages.commitClientPageReservation(replacement)).toBe(replacement.placement)
  })

  it('transfers a retired placement slot to its pending replacement reservation', () => {
    const pages = placements(1)
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const existing = pages.placeClientPage('page-a', host)
    const replacement = pages.reserveClientPage('page-a', host, 5)

    const retirement = pages.beginPageRetirement('page-a', existing)
    expect(pages.completePageRetirement(retirement)).toBe(true)

    expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')
    expect(pages.commitClientPageReservation(replacement)).toBe(replacement.placement)
  })

  it('rejects invalid page identities before consuming placement capacity', () => {
    const pages = placements(1)
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }

    for (const browserPageId of ['', 'x'.repeat(257)]) {
      expect(() => pages.placeClientPage(browserPageId, host)).toThrow(
        'browser_page_identity_invalid'
      )
      expect(() => pages.placeServerPage(browserPageId)).toThrow('browser_page_identity_invalid')
    }
    const maximumIdPlacement = pages.placeServerPage('x'.repeat(256))
    const maximumIdRetirement = pages.beginPageRetirement('x'.repeat(256), maximumIdPlacement)
    expect(pages.completePageRetirement(maximumIdRetirement)).toBe(true)
    expect(pages.placeClientPage('page-a', host)).toMatchObject({
      pageHostGeneration: 1
    })
  })

  it('rejects invalid host identities before allocating a page generation', () => {
    const pages = placements()
    for (const host of [
      { browserHostClientId: '', browserHostGeneration: 1 },
      { browserHostClientId: 'x'.repeat(257), browserHostGeneration: 1 },
      { browserHostClientId: 'host-a', browserHostGeneration: 0 },
      { browserHostClientId: 'host-a', browserHostGeneration: 1.5 },
      { browserHostClientId: 'host-a', browserHostGeneration: 0x1_0000_0000 }
    ]) {
      expect(() => pages.placeClientPage('page-a', host)).toThrow('browser_host_identity_invalid')
    }
    expect(
      pages.placeClientPage('page-a', {
        browserHostClientId: 'x'.repeat(256),
        browserHostGeneration: 1
      })
    ).toMatchObject({ pageHostGeneration: 1 })
  })
})
