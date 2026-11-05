import { describe, expect, it } from 'vitest'
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

const authority = (pageHostGeneration: number) => ({
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserPageId: 'page-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 1,
  pageHostGeneration
})

describe('browser page retirement settlement', () => {
  it('fences a live client page while retirement is pending', () => {
    const pages = registry()
    const placement = pages.placeClientPage('page-a', host)
    const retirement = pages.beginPageRetirement('page-a', placement)

    expect(pages.beginPageRetirement('page-a', placement)).toBe(retirement)
    expect(() => pages.requireClientPage(authority(1))).toThrow('browser_page_retirement_pending')
    expect(() => pages.requireClientPage(authority(2))).toThrow('browser_page_placement_stale')
    expect(() => pages.placeClientPage('page-a', host)).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(() => pages.placeServerPage('page-a')).toThrow(
      'browser_page_replacement_requires_retirement'
    )
    expect(pages.getPlacement('page-a')).toBe(placement)
  })

  it('cancels exact retirement and rejects its delayed settlement', () => {
    const pages = registry()
    const placement = pages.placeClientPage('page-a', host)
    const first = pages.beginPageRetirement('page-a', placement)

    expect(pages.cancelPageRetirement(first)).toBe(true)
    expect(pages.requireClientPage(authority(1))).toBe(placement)
    expect(pages.cancelPageRetirement(first)).toBe(false)
    expect(pages.completePageRetirement(first)).toBe(false)

    const replacement = pages.beginPageRetirement('page-a', placement)
    expect(replacement).not.toBe(first)
    expect(pages.completePageRetirement(first)).toBe(false)
    expect(pages.getPlacement('page-a')).toBe(placement)
    expect(pages.cancelPageRetirement(replacement)).toBe(true)
    expect(pages.requireClientPage(authority(1))).toBe(placement)
  })

  it('completes only exact retirement and preserves page generations', () => {
    const pages = registry()
    const placement = pages.placeClientPage('page-a', host)
    const retirement = pages.beginPageRetirement('page-a', placement)

    expect(pages.completePageRetirement(retirement)).toBe(true)
    expect(pages.getPlacement('page-a')).toBeUndefined()
    expect(pages.completePageRetirement(retirement)).toBe(false)

    const replacement = pages.placeClientPage('page-a', host)
    expect(replacement.pageHostGeneration).toBe(placement.pageHostGeneration + 1)
    expect(() => pages.beginPageRetirement('page-a', placement)).toThrow(
      'browser_page_placement_stale'
    )
    expect(pages.getPlacement('page-a')).toBe(replacement)
  })

  it('serializes completion against cancellation and recursive completion', () => {
    const pages = registry()
    const placement = pages.placeClientPage('page-a', host)
    const retirement = pages.beginPageRetirement('page-a', placement)
    let cancellationAccepted = true

    expect(
      pages.completePageRetirement(retirement, () => {
        cancellationAccepted = pages.cancelPageRetirement(retirement)
        expect(() => pages.completePageRetirement(retirement)).toThrow(
          'browser_page_retirement_completion_pending'
        )
      })
    ).toBe(true)
    expect(cancellationAccepted).toBe(false)
    expect(pages.getPlacement('page-a')).toBeUndefined()
  })

  it('leaves failed completion pending and retryable', () => {
    const pages = registry()
    const placement = pages.placeClientPage('page-a', host)
    const retirement = pages.beginPageRetirement('page-a', placement)

    expect(() =>
      pages.completePageRetirement(retirement, () => {
        throw new Error('destroy failed')
      })
    ).toThrow('destroy failed')
    expect(() => pages.requireClientPage(authority(1))).toThrow('browser_page_retirement_pending')
    expect(pages.completePageRetirement(retirement)).toBe(true)
  })

  it('retains capacity until retirement completion', () => {
    const pages = registry(1)
    const placement = pages.placeClientPage('page-a', host)
    const first = pages.beginPageRetirement('page-a', placement)

    expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')
    expect(pages.cancelPageRetirement(first)).toBe(true)
    expect(() => pages.placeServerPage('page-b')).toThrow('browser_page_placement_capacity')

    const replacement = pages.beginPageRetirement('page-a', placement)
    expect(pages.completePageRetirement(replacement)).toBe(true)
    expect(pages.placeServerPage('page-b')).toEqual({ kind: 'server' })
  })

  it('settles server placement through the same exact barrier', () => {
    const pages = registry()
    const placement = pages.placeServerPage('page-a')
    const first = pages.beginPageRetirement('page-a', placement)

    expect(pages.cancelPageRetirement(first)).toBe(true)
    expect(pages.getPlacement('page-a')).toBe(placement)
    const replacement = pages.beginPageRetirement('page-a', placement)
    expect(pages.completePageRetirement(first)).toBe(false)
    expect(pages.completePageRetirement(replacement)).toBe(true)
    expect(pages.placeClientPage('page-a', host)).toMatchObject({ pageHostGeneration: 1 })
  })
})
