import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobilePairingConnectionContext, OrcaRuntimeRpcServer } from '../runtime-rpc'
import { RelayHttpError } from './relay-http-client'

const fakes = vi.hoisted(() => ({
  readRelayAuthContext: vi.fn(),
  connect: vi.fn(),
  newBroker: (): unknown => undefined
}))

vi.mock('./relay-auth-context', () => ({ readRelayAuthContext: fakes.readRelayAuthContext }))

vi.mock('./relay-session-broker', () => {
  class RelaySessionBroker {
    readonly hostId = 'relay-host-1'
    readonly ownerIdentityKey = 'user-1\0profile-1\0org-1'
    readonly endpoint = { v: 1 as const, relayHostId: 'relay-host-1' }
    isLive(): boolean {
      return true
    }
    closeNow(): void {}
    async createPairingRelay(relayDeviceId: string): Promise<unknown> {
      return { v: 1, relayHostId: this.hostId, relayDeviceId, inviteExpiresAt: 0 }
    }
    static connect = fakes.connect
  }
  fakes.newBroker = () => new RelaySessionBroker()
  return { RelaySessionBroker }
})

import { DesktopRelayService } from './desktop-relay-service'

const context: MobilePairingConnectionContext = {
  deviceId: 'device-1',
  connectionId: 'conn-1',
  transport: { transport: 'direct' }
}

// One transient failure arms a retry; the retry's open succeeds.
function relayServiceWithTransientFirstOpen(): DesktopRelayService {
  vi.useFakeTimers()
  // Why pinned: attempt 0's delay is floor(random() * 1001), so real jitter can
  // put the retry at 0ms and fire it inside the "did not wait" assertion.
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  fakes.connect.mockReset()
  fakes.connect
    .mockRejectedValueOnce(new RelayHttpError('assignment', 500))
    .mockImplementation(async () => fakes.newBroker())
  fakes.readRelayAuthContext.mockResolvedValue({
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    accessToken: 'access-1',
    relayEntitled: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this double implements every runtime-RPC member DesktopRelayService touches on the pairing and endpoint paths; the rest of the surface is never reached.
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
    }),
    setMobileRelayBinding: () => true
  } as unknown as OrcaRuntimeRpcServer
  return new DesktopRelayService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the broker is mocked, so only the two relay URLs are read, and both are present.
    authConfig: {
      relayDirectorUrl: 'https://relay.example.test',
      relayTokenEndpoint: 'https://login.example.test/relay-token'
    } as OrcaCloudAuthConfig,
    userDataPath: '/tmp/orca-relay-wait-budget-test',
    appVersion: '1.4.188',
    runtimeRpc,
    onStatus: () => {}
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('DesktopRelayService live-broker wait budget per caller', () => {
  it('answers the endpoint probe at once while a retry is armed', async () => {
    // Why: getEndpoints is the LAN-connected phone's periodic poll. Sitting
    // through the retry would stall a request the local connection already
    // serves, so it must answer "no relay" the moment the open in flight fails.
    const relayService = relayServiceWithTransientFirstOpen()
    try {
      let answer: unknown = null
      const endpoints = relayService.getEndpoints(context, {}).then((value) => {
        answer = value
        return value
      })

      await vi.advanceTimersByTimeAsync(0)

      expect(answer).toEqual({ v: 1, relay: null })
      expect(fakes.connect).toHaveBeenCalledOnce()
      await endpoints
    } finally {
      relayService.stop()
    }
  })

  it('names the signed-out session on a pairing request instead of the generic code', async () => {
    // Why through createPairingRelay: relay-offline-reason.test.ts covers the reason-to-code
    // table, so what is left to pin is that the service's public entry point throws the mapped
    // code rather than the generic relay_control_not_active. A null context arms no retry.
    const relayService = relayServiceWithTransientFirstOpen()
    fakes.readRelayAuthContext.mockResolvedValue(null)
    try {
      await expect(relayService.createPairingRelay('device-1')).rejects.toThrow('relay_signed_out')
    } finally {
      relayService.stop()
    }
  })

  it('still waits through that same armed retry for a pairing request', async () => {
    const relayService = relayServiceWithTransientFirstOpen()
    try {
      let paired = false
      const pairing = relayService.createPairingRelay('device-1').then((value) => {
        paired = true
        return value
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(paired).toBe(false)
      expect(fakes.connect).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(600)

      await expect(pairing).resolves.toMatchObject({ binding: { relayDeviceId: 'device-1' } })
      expect(fakes.connect).toHaveBeenCalledTimes(2)
    } finally {
      relayService.stop()
    }
  })
})
