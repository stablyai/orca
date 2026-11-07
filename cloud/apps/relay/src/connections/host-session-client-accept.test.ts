import { EventEmitter } from 'node:events'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract/close-codes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from '../assignment/assignment-store.js'
import type { RelayConfig } from '../config.js'
import type { CredentialReservation, RelayCredentialStore } from '../credentials/credential-store.js'
import {
  HostSessionRegistry
} from './host-session-registry.js'
import type { RelayRuntimeObserver } from '../observability/relay-observability.js'
import type { RelayTokenClaims } from '../authentication/relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

// 2026-09-04: phone dial timed out during serialized SQL; late accept leaked a 10s lease and failed bind with host_data_reservation_already_bound.

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason ?? ''))
  })
  readonly terminate = vi.fn(() => {
    this.readyState = this.CLOSED
    this.emit('close')
  })
}

const config = {
  port: 8080,
  publicUrl: 'https://relay-c3.example.com',
  cellUrl: 'https://relay-c3.example.com',
  authIssuer: 'https://auth.example.com',
  authAudience: 'orca-relay',
  jwksUrl: 'https://auth.example.com/jwks',
  assignmentSigningKey: new Uint8Array(32),
  role: 'cell',
  cellId: 'production-gce-c3',
  cells: [
    { id: 'production-gce-c3', url: 'https://relay-c3.example.com', capacityRequests: 4_000 }
  ],
  adminAudience: 'https://relay-c3.example.com/v1/admin/drain',
  deployServiceAccount: 'deploy@example.com',
  runtimeServiceAccount: 'runtime@example.com',
  adminJwksUrl: 'https://auth.example.com/admin-jwks',
  databasePoolMax: 10,
  publicAssignmentsEnabled: true,
  publicAssignmentConcurrency: 2,
  publicAssignmentQueueMax: 128,
  publicAssignmentWaitMs: 4_000,
  publicResolveConcurrency: 1,
  publicResolveWaitMs: 5_000,
  publicAssignmentRetryAfterSeconds: 5,
  dataDir: './test-data'
} satisfies RelayConfig

const identity = {
  sub: 'user-1',
  prof: 'profile-1',
  relayHostId: 'abcdefghijklmnop',
  purpose: 'host-control',
  exp: 4_102_444_800
} satisfies RelayTokenClaims

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

const reservation: CredentialReservation = {
  userId: identity.sub,
  relayHostId: identity.relayHostId,
  credentialKind: 'resume',
  relayDeviceId: 'device-1',
  tokenHash: 'hash',
  reservationId: 'reservation-1',
  leaseExpiresAt: Date.now() + 60_000,
  acceptedCredentialVersion: 2,
  acceptedAs: 'current'
}

function harness(options: { random?: () => number; now?: () => number } = {}) {
  const acquireActivity = vi.fn().mockResolvedValue(undefined)
  const releaseActivity = vi.fn().mockResolvedValue(true)
  const assignments = {
    activateControl: vi.fn().mockResolvedValue('control:production-gce-c3:1'),
    markMigrationTargetRegistered: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue({ cellId: config.cellId }),
    acquireActivity,
    renewControlActivity: vi.fn().mockResolvedValue(undefined),
    releaseActivity
  } as unknown as RelayAssignmentStore
  const store = {
    resolveResume: vi.fn().mockResolvedValue({ userId: identity.sub }),
    reserveCredential: vi.fn().mockResolvedValue(reservation),
    failReservation: vi.fn().mockResolvedValue(undefined),
    recordConnectionBasis: vi.fn().mockResolvedValue(undefined),
    deactivateBasis: vi.fn().mockResolvedValue(undefined)
  }
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordClientAcceptAbandoned: vi.fn(),
    recordClientAcceptCompleted: vi.fn(),
    recordControlRtt: vi.fn(),
    recordPhoneRejection: vi.fn(),
    recordPhoneAttachDeadline: vi.fn()
  } satisfies RelayRuntimeObserver
  const registry = new HostSessionRegistry(
    config,
    vi.fn(),
    store as unknown as RelayCredentialStore,
    assignments,
    new ProcessQueuedByteBudget(),
    observer,
    options.now,
    options.random
  )
  const activate = (
    registry as unknown as {
      activate: (
        socket: WebSocket,
        identity: RelayTokenClaims,
        existing: null,
        generation: number,
        rebind: boolean,
        assignmentEpoch: number,
        appVersion: string
      ) => Promise<void>
    }
  ).activate.bind(registry)
  return { registry, store, assignments, acquireActivity, releaseActivity, observer, activate }
}

async function activeHost(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  const control = new FakeSocket()
  await h.activate(control as unknown as WebSocket, identity, null, 1, false, 1, '1.4.197')
  return control
}

describe('client accept abandoned mid-DB-phase', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not admit new source work after a drain crosses activity acquisition', async () => {
    const h = harness()
    const control = await activeHost(h)
    const slow = deferred<void>()
    h.acquireActivity.mockReturnValueOnce(slow.promise)
    const client = new FakeSocket()
    const capacity = { bind: vi.fn(), release: vi.fn() }
    const accepting = h.registry.acceptClient(
      client as unknown as WebSocket,
      identity.relayHostId,
      'credential',
      capacity
    )
    await vi.advanceTimersByTimeAsync(0)
    h.registry.drainHost({
      attemptId: 'attempt',
      userId: identity.sub,
      relayHostId: identity.relayHostId,
      sourceAssignmentEpoch: 1,
      graceMs: 60_000
    })
    slow.resolve()
    await accepting
    expect(control.send).not.toHaveBeenCalledWith(expect.stringContaining('conn-open'))
    expect(capacity.bind).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, expect.any(String))
    expect(h.releaseActivity).toHaveBeenCalled()
  })

  it('does not splice an attachment whose generation retired during basis persistence', async () => {
    const h = harness()
    await activeHost(h)
    const client = new FakeSocket()
    await h.registry.acceptClient(
      client as unknown as WebSocket,
      identity.relayHostId,
      'credential'
    )
    const session = h.registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    const pending = [...session.pendingConns.values()][0]!
    const slow = deferred<void>()
    h.store.recordConnectionBasis.mockReturnValueOnce(slow.promise)
    const host = new FakeSocket()
    const attaching = h.registry.acceptHostData(
      host as unknown as WebSocket,
      pending.connId,
      pending.connTicket,
      1
    )
    await vi.advanceTimersByTimeAsync(0)
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    slow.resolve()
    expect(await attaching).toBe(false)
    expect(session.activeSplices.size).toBe(0)
    expect(h.store.deactivateBasis).toHaveBeenCalledWith(pending.connId)
    expect(client.send).not.toHaveBeenCalledWith(expect.stringContaining('\"ok\":true'))
    expect(host.close).toHaveBeenCalled()
  })

  it('stops after a slow activity acquire when the phone already hung up', async () => {
    const h = harness()
    const control = await activeHost(h)
    const slowAcquire = deferred<void>()
    h.acquireActivity.mockReturnValueOnce(slowAcquire.promise)
    const capacity = { bind: vi.fn(), release: vi.fn() }
    const client = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const accepting = h.registry.acceptClient(
        client as unknown as WebSocket,
        identity.relayHostId,
        'credential',
        capacity
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(h.acquireActivity).toHaveBeenCalledOnce()
      // The phone's 12s bound fires while the cell still waits on Postgres.
      client.close(1000, 'client bound')
      capacity.release()
      slowAcquire.resolve()
      await accepting

      // No conn-open reached the desktop; nothing pending; the lease it just took is
      // released instead of leaking to expiry cleanup; bind never throws.
      expect(control.send).not.toHaveBeenCalledWith(expect.stringContaining('conn-open'))
      expect(capacity.bind).not.toHaveBeenCalled()
      const session = h.registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })
      expect(session?.pendingConns.size).toBe(0)
      expect(h.store.failReservation).toHaveBeenCalledWith(reservation)
      expect(h.releaseActivity).toHaveBeenCalledWith(
        { userId: identity.sub, relayHostId: identity.relayHostId },
        expect.stringMatching(/^confirmation:/)
      )
      expect(h.observer.recordClientAcceptAbandoned).toHaveBeenCalledWith(
        'activity',
        expect.any(Number)
      )
      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('orca_relay_client_accept_abandoned'))
      expect(line).toBeDefined()
      expect(JSON.parse(line!)).toMatchObject({ stage: 'activity' })
      expect(line).not.toContain(identity.relayHostId)
    } finally {
      warn.mockRestore()
      h.registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })

  it('stops after a slow credential reservation without acquiring an activity lease', async () => {
    const h = harness()
    await activeHost(h)
    const slowReserve = deferred<CredentialReservation>()
    h.store.reserveCredential.mockReturnValueOnce(slowReserve.promise)
    const client = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const accepting = h.registry.acceptClient(
        client as unknown as WebSocket,
        identity.relayHostId,
        'credential'
      )
      await vi.advanceTimersByTimeAsync(0)
      client.close(1000, 'client bound')
      slowReserve.resolve(reservation)
      await accepting

      expect(h.acquireActivity).not.toHaveBeenCalled()
      expect(h.store.failReservation).toHaveBeenCalledWith(reservation)
      expect(h.observer.recordClientAcceptAbandoned).toHaveBeenCalledWith(
        'credential',
        expect.any(Number)
      )
    } finally {
      warn.mockRestore()
      h.registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })

})

// The attach resolves its owning session once and hands it to the unfenced leg;
// these hold the session it must be and the order the client hears about it.
describe('host data attach ownership', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const bystander = { ...identity, sub: 'user-2', relayHostId: 'qponmlkjihgfedcb' }

  async function pendingAttach(h: ReturnType<typeof harness>) {
    const client = new FakeSocket()
    await h.registry.acceptClient(
      client as unknown as WebSocket,
      identity.relayHostId,
      'credential'
    )
    const session = h.registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    return { client, session, pending: [...session.pendingConns.values()][0]! }
  }

  it('attaches the session that owns the connection, not the first one registered', async () => {
    const h = harness()
    const idle = new FakeSocket()
    await h.activate(idle as unknown as WebSocket, bystander, null, 1, false, 1, '1.4.197')
    await activeHost(h)
    const { client, session, pending } = await pendingAttach(h)
    const idleSession = h.registry.get({
      userId: bystander.sub,
      relayHostId: bystander.relayHostId
    })!
    const host = new FakeSocket()
    expect(
      await h.registry.acceptHostData(
        host as unknown as WebSocket,
        pending.connId,
        pending.connTicket,
        1
      )
    ).toBe(true)
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"type":"relay-hello"'))
    expect(session.activeSplices.has(pending.connId)).toBe(true)
    expect(idleSession.activeSplices.size).toBe(0)
    expect(idleSession.activeConnIds.size).toBe(0)
    h.registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('acknowledges the client only after the connection basis is persisted', async () => {
    const h = harness()
    await activeHost(h)
    const { client, session, pending } = await pendingAttach(h)
    const basis = deferred<void>()
    h.store.recordConnectionBasis.mockReturnValueOnce(basis.promise)
    const host = new FakeSocket()
    const attaching = h.registry.acceptHostData(
      host as unknown as WebSocket,
      pending.connId,
      pending.connTicket,
      1
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.recordConnectionBasis).toHaveBeenCalledOnce()
    expect(client.send).not.toHaveBeenCalledWith(expect.stringContaining('relay-hello'))
    basis.resolve()
    expect(await attaching).toBe(true)
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"type":"relay-hello"'))
    expect(session.activeSplices.has(pending.connId)).toBe(true)
    h.registry.drain(0)
    vi.advanceTimersByTime(0)
  })
})

describe('paced drain and the phones of a host not yet told', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const laterHostId = 'qrstuvwxyz012345'
  const laterIdentity = { ...identity, sub: 'user-2', relayHostId: laterHostId }

  async function twoHostCell(): Promise<{
    h: ReturnType<typeof harness>
    told: FakeSocket
    untold: FakeSocket
  }> {
    const h = harness()
    const told = await activeHost(h)
    const untold = new FakeSocket()
    await h.activate(untold as unknown as WebSocket, laterIdentity, null, 1, false, 1, '1.4.197')
    // Both hosts now dial in, so the credential mocks have to answer for either.
    h.store.resolveResume.mockImplementation(async (hostId: string) => ({
      userId: hostId === laterHostId ? laterIdentity.sub : identity.sub
    }))
    h.store.reserveCredential.mockImplementation(async (hostId: string) => ({
      ...reservation,
      userId: hostId === laterHostId ? laterIdentity.sub : identity.sub,
      relayHostId: hostId
    }))
    return { h, told, untold }
  }

  async function dial(h: ReturnType<typeof harness>, hostId: string): Promise<FakeSocket> {
    const client = new FakeSocket()
    await h.registry.acceptClient(client as unknown as WebSocket, hostId, 'credential')
    return client
  }

  it('serves a host whose drain has not been sent and refuses one whose has', async () => {
    const { h, told, untold } = await twoHostCell()
    h.registry.drain(0, { paceWindowMs: 40_000 })

    const refused = await dial(h, identity.relayHostId)
    expect(refused.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, expect.any(String))
    expect(told.send).not.toHaveBeenCalledWith(expect.stringContaining('conn-open'))

    const served = await dial(h, laterHostId)
    expect(served.close).not.toHaveBeenCalled()
    expect(untold.send).toHaveBeenCalledWith(expect.stringContaining('conn-open'))
  })

  it("refuses that host's phones as soon as its own drain is sent", async () => {
    const { h, untold } = await twoHostCell()
    h.registry.drain(0, { paceWindowMs: 40_000 })
    await vi.advanceTimersByTimeAsync(40_000)
    // Told by its zero-grace close, a timer nested 1 ms after the send.
    await vi.advanceTimersByTimeAsync(1)
    expect(untold.send).toHaveBeenCalledWith(expect.stringContaining('"type":"drain"'))

    const refused = await dial(h, laterHostId)
    expect(refused.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, expect.any(String))
  })

})
