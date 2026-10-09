import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

const fakes = vi.hoisted(() => {
  const brokers: { live: boolean }[] = []
  const connectErrors: Error[] = []
  const inviteErrors: Error[] = []
  return { readRelayAuthContext: vi.fn(), brokers, connectErrors, inviteErrors, inviteCalls: 0 }
})

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
      fakes.inviteCalls++
      if (!this.live) {
        throw new Error('relay_control_not_active')
      }
      const inviteError = fakes.inviteErrors.shift()
      if (inviteError) {
        throw inviteError
      }
      return { v: 1, relayHostId: this.hostId, relayDeviceId, inviteExpiresAt: 0 }
    }
    static connect = vi.fn(async () => {
      const connectError = fakes.connectErrors.shift()
      if (connectError) {
        throw connectError
      }
      const broker = new RelaySessionBroker()
      fakes.brokers.push(broker)
      return broker
    })
  }
  return { RelaySessionBroker }
})

import { DesktopRelayService } from './desktop-relay-service'
import { isRetryableInviteError } from './relay-pairing-invite-retry'
import { RelayHttpError } from './relay-http-client'

function service(): DesktopRelayService {
  fakes.brokers.length = 0
  fakes.connectErrors.length = 0
  fakes.inviteErrors.length = 0
  fakes.inviteCalls = 0
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

describe('DesktopRelayService pairing mint grace', () => {
  afterEach(() => vi.useRealTimers())

  it('waits out a connect stall shorter than the grace instead of failing', async () => {
    vi.useFakeTimers()
    const relayService = service()
    fakes.connectErrors.push(new RelayHttpError('assignment', 503), new Error('fetch failed'))
    try {
      const minted = relayService.createPairingRelay('device-1')
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(minted).resolves.toMatchObject({ binding: { relayDeviceId: 'device-1' } })
      expect(fakes.brokers).toHaveLength(1)
    } finally {
      relayService.stop()
    }
  })

  it('fails at the grace deadline when the outage outlasts it', async () => {
    vi.useFakeTimers()
    const relayService = service()
    fakes.connectErrors.push(...Array.from({ length: 50 }, () => new Error('fetch failed')))
    try {
      const minted = relayService.createPairingRelay('device-1')
      let settled = false
      void minted.catch(() => {}).finally(() => (settled = true))
      const rejected = expect(minted).rejects.toThrow('relay_control_not_active')
      await vi.advanceTimersByTimeAsync(14_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      await rejected
    } finally {
      relayService.stop()
    }
  })

  it('fails fast on a terminal connect failure', async () => {
    vi.useFakeTimers()
    const relayService = service()
    fakes.connectErrors.push(new RelayHttpError('assignment', 403))
    try {
      const minted = relayService.createPairingRelay('device-1')
      const rejected = expect(minted).rejects.toThrow('relay_control_not_active')
      await vi.advanceTimersByTimeAsync(0)
      await rejected
    } finally {
      relayService.stop()
    }
  })

  it('fails fast when signed out', async () => {
    const relayService = service()
    fakes.readRelayAuthContext.mockResolvedValue(null)
    try {
      await expect(relayService.createPairingRelay('device-1')).rejects.toThrow(
        'relay_control_not_active'
      )
    } finally {
      relayService.stop()
    }
  })

  it('retries invite-create once after a timeout', async () => {
    const relayService = service()
    fakes.inviteErrors.push(new Error('relay_control_request_timeout'))
    try {
      await expect(relayService.createPairingRelay('device-1')).resolves.toMatchObject({
        binding: { relayDeviceId: 'device-1' }
      })
      expect(fakes.inviteCalls).toBe(2)
    } finally {
      relayService.stop()
    }
  })

  it('surfaces a second invite failure instead of retrying again', async () => {
    const relayService = service()
    fakes.inviteErrors.push(
      new Error('relay_control_request_timeout'),
      new Error('relay_control_request_timeout')
    )
    try {
      await expect(relayService.createPairingRelay('device-1')).rejects.toThrow(
        'relay_control_request_timeout'
      )
      expect(fakes.inviteCalls).toBe(2)
    } finally {
      relayService.stop()
    }
  })

  it('does not retry a deterministic cell refusal', async () => {
    const relayService = service()
    fakes.inviteErrors.push(new Error('rate_limit_exceeded'))
    try {
      await expect(relayService.createPairingRelay('device-1')).rejects.toThrow(
        'rate_limit_exceeded'
      )
      expect(fakes.inviteCalls).toBe(1)
    } finally {
      relayService.stop()
    }
  })

  it('classifies cell DB errors as retryable and refusals as terminal', () => {
    expect(isRetryableInviteError(new Error('timeout exceeded when trying to connect'))).toBe(true)
    expect(isRetryableInviteError(new Error('relay_control_not_active'))).toBe(true)
    expect(isRetryableInviteError(new Error('authorization_expired'))).toBe(false)
    expect(isRetryableInviteError(new Error('assignment_not_found'))).toBe(false)
  })
})
