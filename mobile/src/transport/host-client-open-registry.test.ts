import { describe, expect, it } from 'vitest'
import { HostClientOpenRegistry } from './host-client-open-registry'

describe('HostClientOpenRegistry', () => {
  it('coalesces only opens for the same profile version', () => {
    const registry = new HostClientOpenRegistry()
    const first = Promise.resolve()
    registry.register('host-1', 1, first)

    expect(registry.getActivePromise('host-1', 1)).toBe(first)
    expect(registry.getActivePromise('host-1', 2)).toBeNull()
  })

  it('cancels an older-profile ticket when its replacement registers', () => {
    const registry = new HostClientOpenRegistry()
    const first = registry.register('host-1', 1, Promise.resolve())
    const secondPromise = Promise.resolve()
    registry.register('host-1', 2, secondPromise)

    expect(first.cancelled).toBe(true)
    expect(registry.getActivePromise('host-1', 2)).toBe(secondPromise)
  })
})
