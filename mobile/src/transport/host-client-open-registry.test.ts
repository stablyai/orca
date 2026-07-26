import { describe, expect, it } from 'vitest'
import { HostClientOpenRegistry } from './host-client-open-registry'

describe('HostClientOpenRegistry', () => {
  it('cancels replaced and oldest tickets while bounding pending hosts', () => {
    const registry = new HostClientOpenRegistry(2)
    const first = registry.register('host-a', new Promise<void>(() => {}))
    const replacement = registry.register('host-a', new Promise<void>(() => {}))
    const second = registry.register('host-b', new Promise<void>(() => {}))
    const third = registry.register('host-c', new Promise<void>(() => {}))

    expect(first.cancelled).toBe(true)
    expect(replacement.cancelled).toBe(true)
    expect(second.cancelled).toBe(false)
    expect(third.cancelled).toBe(false)
    expect(registry.getActivePromise('host-a')).toBeNull()
    expect(registry.getActivePromise('host-b')).toBe(second.promise)
    expect(registry.getActivePromise('host-c')).toBe(third.promise)
  })
})
