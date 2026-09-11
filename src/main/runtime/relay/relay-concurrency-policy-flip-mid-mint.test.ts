import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

// The policy-flip fix is normally exercised with the flip sequenced before the
// mint. These cover the interleaving it was written for: the flip lands while
// the mint is parked at an await, so the coordinator reaches `standby` and
// clears the offline reason out from under the waiter.
const fakes = vi.hoisted(() => ({
  readRelayAuthContext: vi.fn(),
  connect: vi.fn(),
  brokers: [] as { closeNow: ReturnType<typeof vi.fn> }[]
}))

vi.mock('./relay-auth-context', () => ({ readRelayAuthContext: fakes.readRelayAuthContext }))

vi.mock('./relay-session-broker', () => {
  class RelaySessionBroker {
    readonly hostId = 'relay-host-1'
    readonly ownerIdentityKey = 'user-1\0profile-1\0org-1'
    readonly endpoint = { v: 1 as const, relayHostId: 'relay-host-1' }
    readonly closeNow = vi.fn()
    createPairingRelay = vi.fn(async (relayDeviceId: string) => ({
      v: 1,
      relayHostId: this.hostId,
      relayDeviceId,
      inviteExpiresAt: 0
    }))
    isLive(): boolean {
      return this.closeNow.mock.calls.length === 0
    }
    static connect = fakes.connect
  }
  return { RelaySessionBroker }
})

import { DesktopRelayService } from './desktop-relay-service'
import { RelaySessionBroker } from './relay-session-broker'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

// The real broker's constructor is private, so the mocked class is the only way
// to produce something `instanceof RelaySessionBroker` for the service's gate.
type FakeBroker = {
  readonly hostId: string
  readonly closeNow: ReturnType<typeof vi.fn>
  createPairingRelay: (relayDeviceId: string) => Promise<unknown>
}

function newBroker(): FakeBroker {
  const broker = new (RelaySessionBroker as unknown as new () => FakeBroker)()
  fakes.brokers.push(broker)
  return broker
}

function service(mode: { current: MobilePairingConnectionMode }): DesktopRelayService {
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
    // `demandingFor` is what hasDemand reads; a stub missing it throws inside reconcile and the
    // mint never settles, which surfaces only as a test timeout.
    getRelayRevokeOutbox: () => ({
      pendingFor: () => [],
      demandingFor: () => [],
      remove: vi.fn()
    }),
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
    userDataPath: '/tmp/orca-relay-policy-flip-interleaving',
    appVersion: '1.4.188',
    runtimeRpc,
    onStatus: () => {},
    hostMobilePairingConnectionMode: () => mode.current
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fakes.brokers.length = 0
  fakes.connect.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DesktopRelayService LAN flip landing mid-mint', () => {
  it('names the flip when it lands while the mint is parked on an in-flight open', async () => {
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const open = deferred<FakeBroker>()
    fakes.connect.mockImplementation(() => open.promise)
    const relayService = service(mode)
    try {
      const mint = relayService.createPairingRelay('device-1')
      const rejection = expect(mint).rejects.toThrow('relay_disabled_for_device')
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalled()

      mode.current = 'local-only'
      relayService.pairingPolicyChanged()
      await vi.advanceTimersByTimeAsync(0)
      await rejection

      // The abandoned open must still be discarded rather than left registered.
      open.resolve(newBroker())
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.brokers[0]!.closeNow).toHaveBeenCalled()
    } finally {
      relayService.stop()
    }
  })

  it('names the flip when it lands after the broker is live, mid create_pairing_relay', async () => {
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const broker = newBroker()
    const mintCall = deferred<never>()
    const relayService = service(mode)
    broker.createPairingRelay = vi.fn(async () => {
      mode.current = 'local-only'
      relayService.pairingPolicyChanged()
      await mintCall.promise
      throw new Error('unreachable')
    })
    fakes.connect.mockResolvedValue(broker)
    try {
      const mint = relayService.createPairingRelay('device-1')
      const rejection = expect(mint).rejects.toThrow('relay_disabled_for_device')
      await vi.advanceTimersByTimeAsync(0)
      expect(broker.createPairingRelay).toHaveBeenCalled()

      // The control the flip closed under it fails the call that was in flight.
      mintCall.resolve(undefined as never)
      await vi.advanceTimersByTimeAsync(0)
      await rejection
    } finally {
      relayService.stop()
    }
  })

  it('leaves the real failure alone when the flip is reverted before the mint fails', async () => {
    // The rewrite reads the live policy at the moment of failure, so a flip that
    // is undone in the same window must not claim a failure it did not cause.
    const mode = { current: 'automatic' as MobilePairingConnectionMode }
    const broker = newBroker()
    broker.createPairingRelay = vi.fn(async () => {
      mode.current = 'local-only'
      await Promise.resolve()
      mode.current = 'automatic'
      throw new Error('relay_assignment_failed_500')
    })
    fakes.connect.mockResolvedValue(broker)
    const relayService = service(mode)
    try {
      await expect(relayService.createPairingRelay('device-1')).rejects.toThrow(
        'relay_assignment_failed_500'
      )
    } finally {
      relayService.stop()
    }
  })
})
