import { describe, expect, it } from 'vitest'
import {
  advertisePairingDirectEndpoints,
  MAX_ADVERTISED_DIRECT_ENDPOINTS,
  resolveDesktopDirectEndpoints
} from './pairing-direct-endpoints'
import type { PairingNetworkInterface } from '../../shared/pairing-address-auto-selection'

const LAN: PairingNetworkInterface = { name: 'en0', address: '192.168.1.20' }
const TAILSCALE: PairingNetworkInterface = { name: 'tailscale0', address: '100.64.0.2' }
const DOCKER: PairingNetworkInterface = { name: 'docker0', address: '172.17.0.1' }
const LOOPBACK: PairingNetworkInterface = { name: 'lo0', address: '127.0.0.1' }
const FAKE_IP: PairingNetworkInterface = { name: 'utun4', address: '198.18.0.1' }

describe('advertisePairingDirectEndpoints', () => {
  it('advertises the current LAN and Tailscale addresses on a wide bind', () => {
    expect(
      advertisePairingDirectEndpoints({
        boundEndpoint: 'ws://0.0.0.0:6768',
        interfaces: [LAN, TAILSCALE]
      })
    ).toEqual({
      v: 1,
      selected: { kind: 'tailscale', url: 'ws://100.64.0.2:6768' },
      endpoints: [
        { kind: 'tailscale', url: 'ws://100.64.0.2:6768' },
        { kind: 'lan', url: 'ws://192.168.1.20:6768' }
      ]
    })
  })

  it('uses the actual bound WebSocket port', () => {
    expect(
      advertisePairingDirectEndpoints({
        boundEndpoint: 'ws://0.0.0.0:7443',
        interfaces: [LAN]
      }).selected
    ).toEqual({ kind: 'lan', url: 'ws://192.168.1.20:7443' })
  })

  it('does not advertise LAN while the listener is still loopback-bound', () => {
    expect(
      advertisePairingDirectEndpoints({
        boundEndpoint: 'ws://127.0.0.1:6768',
        interfaces: [LAN, TAILSCALE]
      })
    ).toEqual({ v: 1, selected: null, endpoints: [] })
  })

  it('never advertises loopback, docker bridges, or proxy fake IPs', () => {
    expect(
      advertisePairingDirectEndpoints({
        boundEndpoint: 'ws://0.0.0.0:6768',
        interfaces: [LOOPBACK, DOCKER, FAKE_IP, LAN]
      })
    ).toEqual({
      v: 1,
      selected: { kind: 'lan', url: 'ws://192.168.1.20:6768' },
      endpoints: [{ kind: 'lan', url: 'ws://192.168.1.20:6768' }]
    })
  })

  it('caps the ranked list so the overlay stays within 16', () => {
    const interfaces = Array.from({ length: 20 }, (_, index) => ({
      name: `en${index}`,
      address: `10.0.0.${index + 1}`
    }))
    const result = advertisePairingDirectEndpoints({
      boundEndpoint: 'ws://0.0.0.0:6768',
      interfaces
    })
    expect(result.endpoints).toHaveLength(MAX_ADVERTISED_DIRECT_ENDPOINTS)
    expect(result.endpoints.length).toBeLessThan(16)
  })
})

describe('resolveDesktopDirectEndpoints', () => {
  it('does not invent a path for local-only devices', async () => {
    await expect(
      resolveDesktopDirectEndpoints({
        connectionMode: 'local-only',
        boundEndpoint: 'ws://0.0.0.0:6768'
      })
    ).resolves.toEqual({ v: 1, selected: null, endpoints: [] })
  })
})
