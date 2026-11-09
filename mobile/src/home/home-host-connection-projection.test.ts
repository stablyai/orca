import { describe, expect, it } from 'vitest'
import {
  projectHomeHostConnections,
  type HomeHostConnectionProjectionEntry
} from './home-host-connection-projection'

function entry(
  hostId: string,
  overrides: Partial<HomeHostConnectionProjectionEntry> = {}
): HomeHostConnectionProjectionEntry {
  return {
    hostId,
    path: 'lan',
    pendingPath: null,
    pairingRejected: false,
    relayHostReachability: 'connecting',
    ...overrides
  }
}

describe('projectHomeHostConnections', () => {
  it('keys connection entries by host without losing their recovery state', () => {
    const offline = entry('desk', {
      pendingPath: 'tailscale',
      pairingRejected: true,
      relayHostReachability: 'signed-out'
    })
    const connected = entry('laptop', { path: 'relay' })
    const projection = projectHomeHostConnections([offline, connected])

    expect(projection['desk']).toBe(offline)
    expect(projection['laptop']).toBe(connected)
  })

  it('keeps a host named __proto__ as an own key', () => {
    const projection = projectHomeHostConnections([entry('__proto__', { path: 'relay' })])

    expect(Object.hasOwn(projection, '__proto__')).toBe(true)
    expect(projection['__proto__']?.path).toBe('relay')
    expect(Object.getPrototypeOf(projection)).toBe(Object.prototype)
  })
})
