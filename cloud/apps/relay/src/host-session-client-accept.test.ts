import { EventEmitter } from 'node:events'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import type { CredentialReservation, RelayCredentialStore } from './credential-store.js'
import {
  CONTROL_LEASE_JITTER_MS,
  CONTROL_LEASE_MS,
  HostSessionRegistry
} from './host-session-registry.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

// Incident 2026-09-04 ~01:05Z: the phone's dial bound ran out while the cell was
// still inside acceptClient's serialized Postgres phase (cell-inventory lock
// contention). The cell then finished the work for a socket nobody held, holding
// an activity lease for the 10s attach deadline before its timer unwound it, and
// logged `host_data_reservation_already_bound`.

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
  cells: [{ id: 'production-gce-c3', url: 'https://relay-c3.example.com', capacityRequests: 4_000 }],
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
    failReservation: vi.fn().mockResolvedValue(undefined)
  }
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordClientAcceptAbandoned: vi.fn()
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
      const line = warn.mock.calls.map((call) => String(call[0])).find((entry) =>
        entry.includes('orca_relay_client_accept_abandoned')
      )
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

  it('stops after a slow resume lookup before starting the invite and assignment lookups', async () => {
    const h = harness()
    await activeHost(h)
    const store = h.store as typeof h.store & { resolveInviteForMove: ReturnType<typeof vi.fn> }
    store.resolveInviteForMove = vi.fn().mockResolvedValue(null)
    const slowResume = deferred<null>()
    h.store.resolveResume.mockReturnValueOnce(slowResume.promise)
    const resolveAssignment = (h.assignments as unknown as { resolve: ReturnType<typeof vi.fn> })
      .resolve
    resolveAssignment.mockClear()
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
      slowResume.resolve(null)
      await accepting

      expect(store.resolveInviteForMove).not.toHaveBeenCalled()
      expect(resolveAssignment).not.toHaveBeenCalled()
      expect(h.store.reserveCredential).not.toHaveBeenCalled()
      expect(h.observer.recordClientAcceptAbandoned).toHaveBeenCalledWith(
        'assignment',
        expect.any(Number)
      )
    } finally {
      warn.mockRestore()
      h.registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })

  it('stops after a slow same-cell assignment resolve, before reserving a credential', async () => {
    const h = harness()
    await activeHost(h)
    const resolveAssignment = (h.assignments as unknown as { resolve: ReturnType<typeof vi.fn> })
      .resolve
    const slowResolve = deferred<{ cellId: string }>()
    resolveAssignment.mockReturnValueOnce(slowResolve.promise)
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
      // A correct, same-cell assignment: only the closed socket stops the accept.
      slowResolve.resolve({ cellId: config.cellId })
      await accepting

      // Proves the accept reached the third guard, not the first.
      expect(resolveAssignment).toHaveBeenCalled()
      expect(h.store.reserveCredential).not.toHaveBeenCalled()
      expect(h.observer.recordClientAcceptAbandoned).toHaveBeenCalledWith(
        'assignment',
        expect.any(Number)
      )
    } finally {
      warn.mockRestore()
      h.registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })

  it('still opens the connection when the phone is holding on', async () => {
    const h = harness()
    const control = await activeHost(h)
    const capacity = { bind: vi.fn(), release: vi.fn() }
    const client = new FakeSocket()
    await h.registry.acceptClient(
      client as unknown as WebSocket,
      identity.relayHostId,
      'credential',
      capacity
    )
    expect(control.send).toHaveBeenCalledWith(expect.stringContaining('"type":"conn-open"'))
    expect(capacity.bind).toHaveBeenCalledOnce()
    expect(h.observer.recordClientAcceptAbandoned).not.toHaveBeenCalled()
    expect(client.close).not.toHaveBeenCalled()
    h.registry.drain(0)
    vi.advanceTimersByTime(0)
  })
})

describe('control lease jitter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('grants a lease uniformly around its mean so cohorts drift apart at the same mean rate', async () => {
    const now = 1_700_000_000_000
    const helloAck = (socket: FakeSocket) =>
      JSON.parse(
        String(socket.send.mock.calls.find((call) => String(call[0]).includes('host-hello-ack'))![0])
      ) as { leaseExpiresAt: number }

    const shortest = harness({ now: () => now, random: () => 0 })
    const shortestAck = helloAck(await activeHost(shortest))
    const centered = harness({ now: () => now, random: () => 0.5 })
    const centeredAck = helloAck(await activeHost(centered))
    const longestRoll = 0.999999
    const longest = harness({ now: () => now, random: () => longestRoll })
    const longestAck = helloAck(await activeHost(longest))

    // Pinned, not bounded: a jitter clamped to one side still satisfies an upper
    // bound, so only the exact top of the band proves it is symmetric.
    const longestOffset = Math.floor((longestRoll * 2 - 1) * CONTROL_LEASE_JITTER_MS)
    expect(shortestAck.leaseExpiresAt).toBe(now + CONTROL_LEASE_MS - CONTROL_LEASE_JITTER_MS)
    expect(centeredAck.leaseExpiresAt).toBe(now + CONTROL_LEASE_MS)
    expect(longestAck.leaseExpiresAt).toBe(now + CONTROL_LEASE_MS + longestOffset)
    shortest.registry.drain(0)
    centered.registry.drain(0)
    longest.registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('rebinds re-roll the jitter instead of pinning the cohort phase', async () => {
    const now = 1_700_000_000_000
    let roll = 0
    const h = harness({ now: () => now, random: () => roll })
    const first = await activeHost(h)
    const session = h.registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    const firstLease = session.leaseExpiresAt
    roll = 0.75
    const rebind = new FakeSocket()
    await (
      h.registry as unknown as {
        activate: (...args: unknown[]) => Promise<void>
      }
    ).activate(rebind as unknown as WebSocket, identity, session, 1, true, 1, '1.4.197')
    expect(session.leaseExpiresAt).toBe(now + CONTROL_LEASE_MS + CONTROL_LEASE_JITTER_MS / 2)
    expect(session.leaseExpiresAt).not.toBe(firstLease)
    expect(first.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.PEER_DROPPED, 'control rebound')
    h.registry.drain(0)
    vi.advanceTimersByTime(0)
  })
})
