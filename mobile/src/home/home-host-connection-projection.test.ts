import { describe, expect, it } from 'vitest'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
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
  it('keys every entry by host id without copying its fields', () => {
    let hostIdReads = 0
    let pathReads = 0
    const counted: HomeHostConnectionProjectionEntry = {
      get hostId() {
        hostIdReads += 1
        return 'host-0'
      },
      get path(): MobileConnectionPath {
        pathReads += 1
        return 'relay'
      },
      pendingPath: null,
      pairingRejected: false,
      relayHostReachability: 'connecting'
    }

    const projection = projectHomeHostConnections([counted, entry('host-1', { path: 'relay' })])

    // Only the key is read; the row reads the rest straight off the entry.
    expect(hostIdReads).toBe(1)
    expect(pathReads).toBe(0)
    expect(projection['host-0']).toBe(counted)
    expect(projection['host-1']?.path).toBe('relay')
  })

  it('carries every connection field through untouched', () => {
    const offline = entry('desk', {
      pendingPath: 'tailscale',
      pairingRejected: true,
      relayHostReachability: 'signed-out'
    })
    expect(projectHomeHostConnections([offline])['desk']).toEqual(offline)
  })

  it('keeps a host named __proto__ as an own key', () => {
    const projection = projectHomeHostConnections([entry('__proto__', { path: 'relay' })])

    expect(Object.hasOwn(projection, '__proto__')).toBe(true)
    expect(projection['__proto__']?.path).toBe('relay')
    expect(Object.getPrototypeOf(projection)).toBe(Object.prototype)
  })
})
