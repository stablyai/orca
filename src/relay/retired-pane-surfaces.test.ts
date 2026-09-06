import { describe, expect, it } from 'vitest'
import { RETIRED_PANE_SURFACE_LIMIT, RetiredPaneSurfaceRegistry } from './retired-pane-surfaces'

describe('RetiredPaneSurfaceRegistry', () => {
  it('records a retired pane and forgets it once the surface exists again', () => {
    const registry = new RetiredPaneSurfaceRegistry()

    expect(registry.isRetired('pane-a')).toBe(false)
    registry.retire('pane-a')
    expect(registry.isRetired('pane-a')).toBe(true)

    registry.restore('pane-a')
    expect(registry.isRetired('pane-a')).toBe(false)
  })

  it('ignores empty pane keys rather than retiring a catch-all entry', () => {
    const registry = new RetiredPaneSurfaceRegistry()

    registry.retire('')
    expect(registry.size).toBe(0)
    expect(registry.isRetired('')).toBe(false)
  })

  it('caps growth by evicting the longest-retired pane', () => {
    const registry = new RetiredPaneSurfaceRegistry()

    for (let index = 0; index < RETIRED_PANE_SURFACE_LIMIT + 25; index += 1) {
      registry.retire(`pane-${index}`)
    }

    expect(registry.size).toBe(RETIRED_PANE_SURFACE_LIMIT)
    expect(registry.isRetired('pane-0')).toBe(false)
    expect(registry.isRetired('pane-24')).toBe(false)
    expect(registry.isRetired('pane-25')).toBe(true)
    expect(registry.isRetired(`pane-${RETIRED_PANE_SURFACE_LIMIT + 24}`)).toBe(true)
  })

  it('re-retiring refreshes recency so an active pane is not evicted first', () => {
    const registry = new RetiredPaneSurfaceRegistry()

    registry.retire('pane-oldest')
    for (let index = 0; index < RETIRED_PANE_SURFACE_LIMIT - 1; index += 1) {
      registry.retire(`pane-${index}`)
    }
    registry.retire('pane-oldest')
    registry.retire('pane-overflow')

    expect(registry.isRetired('pane-oldest')).toBe(true)
    expect(registry.isRetired('pane-0')).toBe(false)
  })
})
