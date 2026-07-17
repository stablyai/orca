import { describe, expect, it } from 'vitest'
import { buildMobileAccessRoutes, orderedHostAccessRoutes } from './mobile-access-route-order'
import type { HostProfile } from './types'

const directA = 'ws://100.64.1.20:6768'
const directB = 'ws://192.168.1.10:6768'
const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

function host(lastGoodEndpoint?: string): HostProfile {
  return {
    id: 'host-1',
    name: 'Blue Whale',
    endpoint: directA,
    deviceToken: 'token',
    publicKeyB64: 'A'.repeat(44),
    lastConnected: 1,
    lastGoodEndpoint,
    endpoints: buildMobileAccessRoutes({
      directUrls: [directA, directB],
      relay,
      relayPreferenceIndex: 1
    }),
    relayHostId: relay.relayHostId,
    relay
  }
}

describe('mobile access route order', () => {
  it('inserts Relay at the selected preference index', () => {
    expect(host().endpoints?.map(({ kind }) => kind)).toEqual(['tailscale', 'relay', 'lan'])
  })

  it('hoists a configured last-good route without mutating durable order', () => {
    const configured = host()
    const relayUrl = configured.endpoints![1]!.url
    const sticky = { ...configured, lastGoodEndpoint: relayUrl }

    expect(orderedHostAccessRoutes(sticky).map(({ kind }) => kind)).toEqual([
      'relay',
      'tailscale',
      'lan'
    ])
    expect(sticky.endpoints?.map(({ kind }) => kind)).toEqual(['tailscale', 'relay', 'lan'])
  })

  it('ignores a stale last-good URL no longer present in the route set', () => {
    expect(orderedHostAccessRoutes(host('ws://old.invalid:6768')).map(({ kind }) => kind)).toEqual([
      'tailscale',
      'relay',
      'lan'
    ])
  })
})
