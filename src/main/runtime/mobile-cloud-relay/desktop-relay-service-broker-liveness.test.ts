import { describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

const fakes = vi.hoisted(() => ({
  readRelayAuthContext: vi.fn(),
  brokers: [] as { live: boolean }[]
}))

vi.mock('./relay-auth-context', () => ({ readRelayAuthContext: fakes.readRelayAuthContext }))

vi.mock('./relay-session-broker', () => {
  // Mirrors the real broker: a control that died rejects with relay_control_not_active.
  class RelaySessionBroker {
    live = true
    readonly hostId = 'relay-host-1'
    readonly ownerIdentityKey = 'user-1\0profile-1\0org-1'
    readonly endpoint = { v: 1 as const, relayHostId: 'relay-host-1' }
    isLive(): boolean {
      return this.live
    }
    closeNow(): void {
      this.live = false
    }
    async createPairingRelay(relayDeviceId: string): Promise<unknown> {
      if (!this.live) {
        throw new Error('relay_control_not_active')
      }
      return { v: 1, relayHostId: this.hostId, relayDeviceId, inviteExpiresAt: 0 }
    }
    static connect = vi.fn(async () => {
      const broker = new RelaySessionBroker()
      fakes.brokers.push(broker)
      return broker
    })
  }
  return { RelaySessionBroker }
})

import { DesktopRelayService } from './desktop-relay-service'

function service(): DesktopRelayService {
  fakes.brokers.length = 0
  fakes.readRelayAuthContext.mockResolvedValue({
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    accessToken: 'access-1',
    relayEntitled: true
  })
  const runtimeRpc = {
    getE2EEKeypair: () => ({
      publicKey: new Uint8Array(32).fill(7),
      secretKey: new Uint8Array(32).fill(9),
      publicKeyB64: 'x'
    }),
    getMobileSocketWiring: () => ({ attachTransport: () => () => {} }),
    getRelayRevokeOutbox: () => ({ pendingFor: () => [], remove: vi.fn() }),
    getDeviceRegistry: () => ({
      listDevices: () => [],
      getDevice: () => ({ deviceId: 'device-1', scope: 'mobile' }),
      getMobilePairingConnectionMode: () => 'automatic'
    })
  } as unknown as OrcaRuntimeRpcServer
  return new DesktopRelayService({
    authConfig: {
      relayDirectorUrl: 'https://relay.example.test',
      relayTokenEndpoint: 'https://login.example.test/relay-token'
    } as OrcaCloudAuthConfig,
    userDataPath: '/tmp/orca-relay-liveness-test',
    appVersion: '1.4.188',
    runtimeRpc,
    onStatus: () => {}
  })
}

describe('DesktopRelayService broker liveness', () => {
  it('pairs through a replacement when the owned broker control died', async () => {
    // Why: ownership stays 'valid' after a control socket dies, so the stale
    // handle otherwise reaches create_pairing_relay and fails the pairing.
    const relayService = service()
    try {
      await expect(relayService.createPairingRelay('device-1')).resolves.toMatchObject({
        binding: { relayDeviceId: 'device-1' }
      })
      expect(fakes.brokers).toHaveLength(1)

      fakes.brokers[0]!.live = false

      await expect(relayService.createPairingRelay('device-2')).resolves.toMatchObject({
        binding: { relayDeviceId: 'device-2' }
      })
      expect(fakes.brokers).toHaveLength(2)
      expect(fakes.brokers[1]!.live).toBe(true)
    } finally {
      relayService.stop()
    }
  })

  it('keeps using a live broker instead of replacing it', async () => {
    const relayService = service()
    try {
      await relayService.createPairingRelay('device-1')
      await relayService.createPairingRelay('device-2')
      expect(fakes.brokers).toHaveLength(1)
    } finally {
      relayService.stop()
    }
  })
})
