import { describe, expect, it } from 'vitest'
import { RelayHostReachabilityLatch } from './relay-host-reachability-latch'

describe('RelayHostReachabilityLatch', () => {
  it('reports an asserted verdict immediately and pins it against later failures', () => {
    const latch = new RelayHostReachabilityLatch()

    latch.assert('signed-out')
    expect(latch.current()).toBe('signed-out')

    latch.record('host-offline')
    latch.record('host-offline')
    expect(latch.current()).toBe('signed-out')

    latch.clear()
    expect(latch.current()).toBe('connecting')
  })
})
