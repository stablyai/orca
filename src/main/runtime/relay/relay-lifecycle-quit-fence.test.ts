import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

// fenceAndCloseNow is what app quit and pre-sign-out both call (stop() is never
// reached in production). Its own comment says the fence must be hard, yet every
// path that survives it lands in refreshDemand, which re-arms the interval the
// fence just cleared and starts a fresh reconcile.
const fakes = vi.hoisted(() => ({
  readRelayAuthContext: vi.fn(),
  connect: vi.fn(),
  brokers: [] as { closeNow: ReturnType<typeof vi.fn> }[]
}))

vi.mock('./relay-auth-context', () => ({ readRelayAuthContext: fakes.readRelayAuthContext }))

vi.mock('./relay-session-broker', () => {
  class RelaySessionBroker {
    readonly hostId: string = hostId
    readonly ownerIdentityKey = 'user-1\0profile-1\0org-1'
    readonly endpoint = { v: 1 as const, relayHostId: hostId }
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
import { deriveRelayHostId } from './relay-http-client'
import { RelaySessionBroker } from './relay-session-broker'

const publicKey = new Uint8Array(32).fill(7)
const hostId = deriveRelayHostId(publicKey)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

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

// A paired phone: standing demand, plus the pending-expiry wake timer
// refreshDemand arms while an invite is still unexpired.
function pairedDevice(inviteExpiresAt?: number) {
  return {
    deviceId: 'device-1',
    scope: 'mobile' as const,
    relayBinding: {
      relayHostId: hostId,
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1',
      ...(inviteExpiresAt === undefined ? {} : { inviteExpiresAt })
    }
  }
}

function service(device: ReturnType<typeof pairedDevice>): DesktopRelayService {
  fakes.readRelayAuthContext.mockResolvedValue({
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    accessToken: 'access-1',
    relayEntitled: true
  })
  const runtimeRpc = {
    getE2EEKeypair: () => ({
      publicKey,
      secretKey: new Uint8Array(32).fill(9),
      publicKeyB64: 'x'
    }),
    getMobileSocketWiring: () => ({ attachTransport: () => () => {} }),
    getRelayRevokeOutbox: () => ({ pendingFor: () => [], demandingFor: () => [], remove: vi.fn() }),
    getDeviceRegistry: () => ({
      listDevices: () => [device],
      getDevice: () => device,
      getMobilePairingConnectionMode: () => 'automatic'
    })
  } as unknown as OrcaRuntimeRpcServer
  return new DesktopRelayService({
    authConfig: {
      relayDirectorUrl: 'https://relay.example.test',
      relayTokenEndpoint: 'https://login.example.test/relay-token'
    } as OrcaCloudAuthConfig,
    userDataPath: '/tmp/orca-relay-quit-fence',
    appVersion: '1.4.188',
    runtimeRpc,
    onStatus: () => {}
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

describe('DesktopRelayService quit fence is hard', () => {
  it('does not let a pending invite-expiry wake resurrect the broker after the fence', async () => {
    const device = pairedDevice(Date.now() + 60_000)
    fakes.connect.mockImplementation(async () => newBroker())
    const relayService = service(device)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalledTimes(1)

      relayService.fenceAndCloseNow()
      expect(fakes.brokers[0]!.closeNow).toHaveBeenCalled()
      // The fence cleared the liveness interval; nothing else may stay armed.
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(120_000)
      expect(fakes.connect).toHaveBeenCalledTimes(1)
    } finally {
      relayService.stop()
    }
  })

  it('does not let a mint settling after the fence re-arm the liveness tick', async () => {
    const device = pairedDevice()
    const broker = newBroker()
    const mintCall = deferred<void>()
    broker.createPairingRelay = vi.fn(async () => {
      await mintCall.promise
      throw new Error('relay_control_closed')
    })
    fakes.connect.mockResolvedValue(broker)
    const relayService = service(device)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      const mint = relayService.createPairingRelay('device-1')
      const rejection = expect(mint).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(0)
      expect(broker.createPairingRelay).toHaveBeenCalled()

      relayService.fenceAndCloseNow()
      expect(vi.getTimerCount()).toBe(0)

      mintCall.resolve()
      await rejection
      await vi.advanceTimersByTimeAsync(0)

      // The settling mint's finally must not bring the fenced service back.
      expect(vi.getTimerCount()).toBe(0)
      expect(fakes.connect).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(fakes.connect).toHaveBeenCalledTimes(1)
    } finally {
      relayService.stop()
    }
  })

  it('does not let a power-resume ensureLive resurrect the broker after the fence', async () => {
    const device = pairedDevice()
    fakes.connect.mockImplementation(async () => newBroker())
    const relayService = service(device)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalledTimes(1)

      relayService.fenceAndCloseNow()
      relayService.ensureLive()
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalledTimes(1)
    } finally {
      relayService.stop()
    }
  })

  it('still re-arms on the next auth mutation, which is the documented recovery', async () => {
    const device = pairedDevice()
    fakes.connect.mockImplementation(async () => newBroker())
    const relayService = service(device)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      relayService.fenceAndCloseNow()

      relayService.authMutated()
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalledTimes(2)
    } finally {
      relayService.stop()
    }
  })

  it('re-arms on an explicit start, the other door out of the fence', async () => {
    const device = pairedDevice()
    fakes.connect.mockImplementation(async () => newBroker())
    const relayService = service(device)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      relayService.fenceAndCloseNow()

      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalledTimes(2)
    } finally {
      relayService.stop()
    }
  })

  it('stays fenced after stop, and a second stop changes nothing', async () => {
    const device = pairedDevice(Date.now() + 60_000)
    fakes.connect.mockImplementation(async () => newBroker())
    const relayService = service(device)
    relayService.start()
    await vi.advanceTimersByTimeAsync(0)

    relayService.stop()
    expect(vi.getTimerCount()).toBe(0)
    relayService.stop()
    expect(vi.getTimerCount()).toBe(0)

    // stop() is terminal: unlike a fence, no door re-arms it.
    relayService.authMutated()
    relayService.start()
    relayService.ensureLive()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fakes.connect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
