import { describe, expect, it } from 'vitest'
import { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'

const placements = (maxPagePlacements = 256): BrowserHostPagePlacementRegistry =>
  new BrowserHostPagePlacementRegistry(
    { authorityRuntimeId: 'runtime-a', authorityEpoch: 'epoch-a' },
    { maxPagePlacements }
  )

describe('browser host page placement authority', () => {
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
})

it('charges one page through reservation cancellation and exact current cleanup', () => {
  const pages = placements(1)
  const host = { browserHostClientId: 'host-a', browserHostGeneration: 1 }
  const reservation = pages.reserveNewClientPage('page-a', host)
  const releaseCleanup = pages.claimClientPageCleanup('page-a')
  pages.cancelClientPageReservation(reservation)
  expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')
  const replacement = pages.reserveNewClientPage('page-a', host)
  pages.commitClientPageReservation(replacement)
  releaseCleanup()
  releaseCleanup()
  expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')
  pages.completePageRetirement(pages.beginPageRetirement('page-a', replacement.placement))
  expect(pages.placeServerPage('page-b')).toEqual({ kind: 'server' })
})
