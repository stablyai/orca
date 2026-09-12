import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

// The outbox flush is launched unawaited from inside the coordinator's open, so
// it crosses every boundary the open does: a fence, a reconnect that replaced
// the broker it was handed, and a second revoke queued for the same reqId.
const fakes = vi.hoisted(() => ({
  readRelayAuthContext: vi.fn(),
  connect: vi.fn()
}))

vi.mock('./relay-auth-context', () => ({ readRelayAuthContext: fakes.readRelayAuthContext }))

vi.mock('./relay-session-broker', () => {
  class RelaySessionBroker {
    readonly hostId: string = hostId
    readonly ownerIdentityKey = ownerIdentityKey
    readonly endpoint = { v: 1 as const, relayHostId: hostId }
    readonly closeNow = vi.fn()
    revokeDevice = vi.fn(async () => {})
    isLive(): boolean {
      return this.closeNow.mock.calls.length === 0
    }
    static connect = fakes.connect
  }
  return { RelaySessionBroker }
})

import { DesktopRelayService } from './desktop-relay-service'
import { deriveRelayHostId } from './relay-http-client'
import { RelayRevokeOutbox, type RelayRevokeOutboxItem } from './relay-revoke-outbox'
import { RelaySessionBroker } from './relay-session-broker'

const publicKey = new Uint8Array(32).fill(7)
const hostId = deriveRelayHostId(publicKey)
const ownerIdentityKey = 'user-1\0profile-1\0org-1'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type FakeBroker = {
  readonly hostId: string
  readonly closeNow: ReturnType<typeof vi.fn>
  revokeDevice: ReturnType<typeof vi.fn>
}

function newBroker(): FakeBroker {
  return new (RelaySessionBroker as unknown as new () => FakeBroker)()
}

let userDataPath: string

function outboxOnDisk(): RelayRevokeOutboxItem[] {
  return JSON.parse(
    readFileSync(join(userDataPath, 'mobile-relay-revoke-outbox.json'), 'utf-8')
  ) as RelayRevokeOutboxItem[]
}

// A paired phone, so standing demand survives the outbox draining to empty and
// the broker stays registered for the next queued revoke.
const pairedDevice = {
  deviceId: 'device-paired',
  scope: 'mobile' as const,
  relayBinding: { relayHostId: hostId, relayDeviceId: 'device-paired', ownerIdentityKey }
}

function service(
  outbox: RelayRevokeOutbox,
  onStatus: (status: string) => void = () => {},
  devices: (typeof pairedDevice)[] = []
): DesktopRelayService {
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
    getRelayRevokeOutbox: () => outbox,
    getDeviceRegistry: () => ({
      listDevices: () => devices,
      getDevice: () => ({ deviceId: 'device-1', scope: 'mobile' }),
      getMobilePairingConnectionMode: () => 'automatic'
    })
  } as unknown as OrcaRuntimeRpcServer
  return new DesktopRelayService({
    authConfig: {
      relayDirectorUrl: 'https://relay.example.test',
      relayTokenEndpoint: 'https://login.example.test/relay-token'
    } as OrcaCloudAuthConfig,
    userDataPath,
    appVersion: '1.4.188',
    runtimeRpc,
    onStatus
  })
}

function queued(outbox: RelayRevokeOutbox, relayDeviceId: string): RelayRevokeOutboxItem {
  return outbox.enqueue({ relayHostId: hostId, relayDeviceId, ownerIdentityKey })
}

beforeEach(() => {
  vi.useFakeTimers()
  fakes.connect.mockReset()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-outbox-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('revoke-outbox flush crossing a fence', () => {
  it('does not issue control revokes through a broker the fence already discarded', async () => {
    const outbox = new RelayRevokeOutbox(userDataPath)
    queued(outbox, 'device-1')
    const open = deferred<FakeBroker>()
    fakes.connect.mockImplementation(() => open.promise)
    const relayService = service(outbox)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.connect).toHaveBeenCalledTimes(1)

      relayService.fenceAndCloseNow()
      const broker = newBroker()
      open.resolve(broker)
      await vi.advanceTimersByTimeAsync(0)

      expect(broker.revokeDevice).not.toHaveBeenCalled()
      expect(broker.closeNow).toHaveBeenCalled()
      // Durable, so deferring to the next launch loses nothing.
      expect(outboxOnDisk()).toHaveLength(1)
    } finally {
      relayService.stop()
    }
  })

  it('stops mid-flush when the fence lands between two items', async () => {
    const outbox = new RelayRevokeOutbox(userDataPath)
    queued(outbox, 'device-1')
    queued(outbox, 'device-2')
    const broker = newBroker()
    const firstRevoke = deferred<void>()
    broker.revokeDevice = vi.fn(async () => await firstRevoke.promise)
    fakes.connect.mockResolvedValue(broker)
    const relayService = service(outbox)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(broker.revokeDevice).toHaveBeenCalledTimes(1)

      relayService.fenceAndCloseNow()
      firstRevoke.resolve()
      await vi.advanceTimersByTimeAsync(0)

      // device-1 really was revoked, so its item is gone; device-2 never went out.
      expect(broker.revokeDevice).toHaveBeenCalledTimes(1)
      expect(outboxOnDisk().map((item) => item.relayDeviceId)).toEqual(['device-2'])
    } finally {
      relayService.stop()
    }
  })
})

describe('revoke-outbox flush driving the coordinator', () => {
  it('drains a multi-item outbox on one broker instead of one open per item', async () => {
    // The flush is launched from inside openBroker, so its per-item demand
    // refresh reconciled against an ownership that was not registered yet: each
    // removal opened a fresh director assignment and abandoned the broker still
    // working through the loop. Measured before the fix: 3 opens for 3 items.
    const outbox = new RelayRevokeOutbox(userDataPath)
    queued(outbox, 'device-1')
    queued(outbox, 'device-2')
    queued(outbox, 'device-3')
    const brokers: FakeBroker[] = []
    const statuses: string[] = []
    fakes.connect.mockImplementation(async () => {
      const broker = newBroker()
      brokers.push(broker)
      return broker
    })
    const relayService = service(outbox, (status) => statuses.push(status))
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(fakes.connect).toHaveBeenCalledTimes(1)
      expect(brokers[0]!.revokeDevice).toHaveBeenCalledTimes(3)
      // One assignment: each extra `connecting` is a director open the drain
      // caused and then abandoned.
      expect(statuses.filter((status) => status === 'connecting')).toHaveLength(1)
      expect(brokers[0]!.closeNow).not.toHaveBeenCalled()
      expect(outboxOnDisk()).toEqual([])
    } finally {
      relayService.stop()
    }
  })

  it('still reconciles once the drain is done so the relay can reach standby', async () => {
    const outbox = new RelayRevokeOutbox(userDataPath)
    queued(outbox, 'device-1')
    const statuses: string[] = []
    const broker = newBroker()
    fakes.connect.mockResolvedValue(broker)
    const relayService = service(outbox, (status) => statuses.push(status))
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(outboxOnDisk()).toEqual([])
      // The last demand is gone, so the drained broker must not stay registered.
      expect(statuses.at(-1)).toBe('standby')
    } finally {
      relayService.stop()
    }
  })

  it('reaches standby when a queued revoke removes the last standing demand', async () => {
    // The runtime drops the device from the registry and then queues the relay
    // revoke, so this flush is what retires the demand holding the control open.
    const outbox = new RelayRevokeOutbox(userDataPath)
    const devices = [pairedDevice]
    const statuses: string[] = []
    const broker = newBroker()
    fakes.connect.mockResolvedValue(broker)
    const relayService = service(outbox, (status) => statuses.push(status), devices)
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(statuses.at(-1)).toBe('registered')

      devices.length = 0
      relayService.onDeviceRevokeQueued(queued(outbox, pairedDevice.deviceId))
      await vi.advanceTimersByTimeAsync(0)

      expect(broker.revokeDevice).toHaveBeenCalledTimes(1)
      expect(statuses.at(-1)).toBe('standby')
    } finally {
      relayService.stop()
    }
  })

  it('settles both flushes when the same revoke is queued twice', async () => {
    const outbox = new RelayRevokeOutbox(userDataPath)
    const broker = newBroker()
    fakes.connect.mockResolvedValue(broker)
    const relayService = service(outbox, () => {}, [pairedDevice])
    try {
      relayService.start()
      await vi.advanceTimersByTimeAsync(0)

      // enqueue returns the existing item for a repeat, so both carry one reqId.
      const item = queued(outbox, 'device-1')
      expect(queued(outbox, 'device-1').reqId).toBe(item.reqId)
      relayService.onDeviceRevokeQueued(item)
      relayService.onDeviceRevokeQueued(item)
      await vi.advanceTimersByTimeAsync(0)

      // Dedup is the control layer's job (duplicate_relay_request_id); the
      // service must simply settle both without stranding the item.
      expect(broker.revokeDevice.mock.calls.map((call) => call[1])).toEqual([
        item.reqId,
        item.reqId
      ])
      expect(outboxOnDisk()).toEqual([])
    } finally {
      relayService.stop()
    }
  })
})
