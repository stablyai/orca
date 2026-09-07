import { describe, expect, it } from 'vitest'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import {
  projectHomeHostConnections,
  type HomeHostConnectionProjectionEntry
} from './home-host-connection-projection'

describe('projectHomeHostConnections', () => {
  it('reads each connection once while preserving all lookup values', () => {
    const entryCount = 1_000
    const reads = {
      hostId: 0,
      path: 0,
      pendingPath: 0,
      pairingRejected: 0
    }
    const entries = Array.from({ length: entryCount }, (_, index) => {
      const hostId = index === entryCount - 1 ? '__proto__' : `host-${index}`
      const path: MobileConnectionPath = index % 2 === 0 ? 'lan' : 'relay'
      const pendingPath = index === 1 ? undefined : index % 2 === 0 ? null : 'tailscale'
      const pairingRejected = index % 3 === 0
      const entry = {} as HomeHostConnectionProjectionEntry
      Object.defineProperties(entry, {
        hostId: {
          enumerable: true,
          get: () => {
            reads.hostId += 1
            return hostId
          }
        },
        path: {
          enumerable: true,
          get: () => {
            reads.path += 1
            return path
          }
        },
        pendingPath: {
          enumerable: true,
          get: () => {
            reads.pendingPath += 1
            return pendingPath
          }
        },
        pairingRejected: {
          enumerable: true,
          get: () => {
            reads.pairingRejected += 1
            return pairingRejected
          }
        }
      })
      return entry
    })

    const projection = projectHomeHostConnections(entries)

    expect(reads).toEqual({
      hostId: entryCount,
      path: entryCount,
      pendingPath: entryCount,
      pairingRejected: entryCount
    })
    expect(Object.keys(projection.hostPaths)).toHaveLength(entryCount)
    expect(Object.keys(projection.hostPendingPaths)).toHaveLength(entryCount)
    expect(Object.keys(projection.hostPairingRejected)).toHaveLength(entryCount)
    expect(projection.hostPaths['host-0']).toBe('lan')
    expect(projection.hostPaths['host-1']).toBe('relay')
    expect(projection.hostPendingPaths['host-0']).toBeNull()
    expect(projection.hostPendingPaths['host-1']).toBeUndefined()
    expect(projection.hostPendingPaths['host-3']).toBe('tailscale')
    expect(projection.hostPairingRejected['host-0']).toBe(true)
    expect(projection.hostPairingRejected['host-1']).toBe(false)
    expect(Object.hasOwn(projection.hostPaths, '__proto__')).toBe(true)
    expect(projection.hostPaths['__proto__']).toBe('relay')
    expect(Object.getPrototypeOf(projection.hostPaths)).toBe(Object.prototype)
  })
})
