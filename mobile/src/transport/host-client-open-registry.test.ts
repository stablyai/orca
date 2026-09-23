import { describe, expect, it } from 'vitest'
import { HostClientOpenRegistry } from './host-client-open-registry'

function retainedHostKeys(registry: HostClientOpenRegistry): number {
  let count = 0
  for (const value of Object.values(registry)) {
    if (value instanceof Map) {
      count += value.size
    }
  }
  return count
}

describe('host client open registry ownership', () => {
  it('releases host keys after repeated open and cancellation cycles', () => {
    const registry = new HostClientOpenRegistry()
    for (let index = 0; index < 1000; index++) {
      const hostId = `removed-host-${index}`
      const ticket = registry.register(hostId, Promise.resolve())
      registry.cancel(hostId)
      expect(registry.isCurrent(hostId, ticket)).toBe(false)
      expect(registry.getActivePromise(hostId)).toBeNull()
    }
    expect(retainedHostKeys(registry)).toBe(0)
  })

  it('releases both pending and settled host keys on cancellation of all opens', () => {
    const registry = new HostClientOpenRegistry()
    for (let index = 0; index < 1000; index++) {
      const hostId = `host-${index}`
      const ticket = registry.register(hostId, Promise.resolve())
      if (index % 2 === 0) {
        registry.deleteIfCurrent(hostId, ticket)
      }
    }
    registry.cancelAll()
    expect(retainedHostKeys(registry)).toBe(0)
  })

  it.each(['one', 'all'])('never reuses a generation after cancelling %s', (mode) => {
    const registry = new HostClientOpenRegistry()
    const previous = registry.register('host', Promise.resolve())
    registry.deleteIfCurrent('host', previous)
    expect(registry.isGenerationCurrent('host', previous.generation)).toBe(true)
    if (mode === 'one') {
      registry.cancel('host')
    } else {
      registry.cancelAll()
    }
    const replacement = registry.register('host', Promise.resolve())
    expect(registry.isGenerationCurrent('host', previous.generation)).toBe(false)
    expect(registry.isCurrent('host', previous)).toBe(false)
    expect(registry.isCurrent('host', replacement)).toBe(true)
    registry.deleteIfCurrent('host', previous)
    expect(registry.getActivePromise('host')).toBe(replacement.promise)
  })
})
