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

  it('fences the placement when its lease is released or replaced', () => {
    const leases = registry()
    const firstHost = attachHost(leases)
    leases.placeClientPage('page-a', 'host-a')

    firstHost.release()
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow('browser_host_lease_required')

    attachHost(leases, 'connection-b')
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow('browser_host_lease_stale')
    const replacement = leases.placeClientPage('page-a', 'host-a')
    expect(leases.requireClientPage(pageAuthority(2, 2))).toBe(replacement)
  })

  it('rejects retired, replaced, and server page placements', () => {
    const leases = registry()
    attachHost(leases)
    const first = leases.placeClientPage('page-a', 'host-a')

    expect(leases.retirePage('page-a', first)).toBe(true)
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow(
      'browser_client_page_placement_required'
    )
    const replacement = leases.placeClientPage('page-a', 'host-a')
    expect(() => leases.requireClientPage(pageAuthority(1))).toThrow('browser_page_placement_stale')
    expect(leases.requireClientPage(pageAuthority(2))).toBe(replacement)

    leases.placeServerPage('page-a')
    expect(() => leases.requireClientPage(pageAuthority(2))).toThrow(
      'browser_client_page_placement_required'
    )
  })

  it('bounds live logical placements without blocking exact replacement', () => {
    const pages = placements(1)
    const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
    const first = pages.placeClientPage('page-a', host)

    expect(() => pages.placeClientPage('page-b', host)).toThrow('browser_page_placement_capacity')
    expect(pages.placeClientPage('page-a', host)).toMatchObject({
      pageHostGeneration: first.pageHostGeneration + 1
    })
    expect(pages.retirePage('page-a', pages.getPlacement('page-a')!)).toBe(true)
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
    expect(pages.retirePage('page-0', admitted[0]!)).toBe(true)
    expect(pages.placeClientPage('page-overflow', host)).toMatchObject({
      pageHostGeneration: 257
    })
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
    expect(pages.retirePage('x'.repeat(256), maximumIdPlacement)).toBe(true)
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
