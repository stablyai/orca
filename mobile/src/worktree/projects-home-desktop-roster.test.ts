import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { HostCatalogEntry, HostProfile } from '../transport/types'
import { buildProjectsHomeDesktopRoster } from './projects-home-desktop-roster'

function profile(id: string): HostProfile {
  return {
    id,
    name: id,
    endpoint: `wss://${id}.example.test`,
    deviceToken: 'token',
    publicKeyB64: 'public-key',
    lastConnected: 1
  }
}

function catalogEntry(
  id: string,
  credentialStatus: HostCatalogEntry['credentialStatus'] = 'ready'
) {
  const host = profile(id)
  return {
    ...host,
    credentialStatus,
    profile: credentialStatus === 'ready' ? host : null
  }
}

describe('buildProjectsHomeDesktopRoster', () => {
  it('keeps every paired desktop actionable through existing or on-demand clients', () => {
    const clients = Array.from({ length: 4 }, () => ({}) as RpcClient)
    const acquireClient = vi.fn()
    const roster = buildProjectsHomeDesktopRoster(
      [
        catalogEntry('desktop-1'),
        catalogEntry('desktop-2'),
        catalogEntry('desktop-3'),
        catalogEntry('desktop-4'),
        catalogEntry('desktop-5'),
        {
          ...catalogEntry('desktop-6', 'missing'),
          profile: profile('desktop-6')
        }
      ],
      clients.map((client, index) => ({
        hostId: `desktop-${index + 1}`,
        client,
        state: 'connected' as const
      })),
      ['desktop-1', 'desktop-2', 'desktop-3'],
      acquireClient
    )

    expect(roster).toHaveLength(6)
    expect(roster.slice(0, 3).map((desktop) => desktop.client)).toEqual(clients.slice(0, 3))
    expect(roster[3]).toMatchObject({
      hostId: 'desktop-4',
      client: clients[3],
      state: 'connected',
      availableOnDemand: false
    })
    expect(roster[4]).toMatchObject({
      hostId: 'desktop-5',
      client: null,
      state: 'disconnected',
      availableOnDemand: true,
      acquireClient
    })
    expect(roster[5]).toMatchObject({
      hostId: 'desktop-6',
      client: null,
      state: 'auth-failed',
      availableOnDemand: false
    })
    expect(roster[5]).not.toHaveProperty('profile')
    expect(roster[5]).not.toHaveProperty('acquireClient')
  })
})
