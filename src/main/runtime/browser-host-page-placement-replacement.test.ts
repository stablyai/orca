import { describe, expect, it } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'

const host = {
  browserHostClientId: 'host-a',
  browserHostGeneration: 1
}

const registry = (maxPagePlacements = 256): BrowserHostPagePlacementRegistry =>
  new BrowserHostPagePlacementRegistry(
    { authorityRuntimeId: 'runtime-a', authorityEpoch: 'epoch-a' },
    { maxPagePlacements }
  )

describe('browser page placement replacement barrier', () => {
  it('requires exact retirement before replacing a client placement', () => {
    const pages = registry()
    const original = pages.placeClientPage('page-a', host)

    expect(() => pages.placeClientPage('page-a', host)).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(() => pages.placeServerPage('page-a')).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(pages.getPlacement('page-a')).toBe(original)
  })

  it('requires exact retirement before replacing a server placement', () => {
    const pages = registry()
    const original = pages.placeServerPage('page-a')

    expect(() => pages.placeServerPage('page-a')).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(() => pages.placeClientPage('page-a', host)).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(pages.getPlacement('page-a')).toBe(original)
  })

  it('keeps capacity occupied until exact retirement and preserves generations', () => {
    const pages = registry(1)
    const original = pages.placeClientPage('page-a', host)

    expect(() => pages.placeClientPage('page-a', host)).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')
    const retirement = pages.beginPageRetirement('page-a', original)
    expect(pages.completePageRetirement(retirement)).toBe(true)

    const replacement = pages.placeClientPage('page-a', host)
    expect(replacement.pageHostGeneration).toBe(original.pageHostGeneration + 1)
    expect(pages.completePageRetirement(retirement)).toBe(false)
    expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')
    expect(pages.getPlacement('page-a')).toBe(replacement)
  })

  it('rejects replacement before resolving a client host', () => {
    const leases = new BrowserHostLeaseRegistry({
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a'
    })
    const original = leases.placeServerPage('page-a')

    expect(() => leases.placeClientPage('page-a')).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(leases.getPlacement('page-a')).toBe(original)
  })
})
