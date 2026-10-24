import { EventEmitter } from 'node:events'
import {
  ASSIGNMENT_LIMITS,
  CONTROL_CONTINUITY_LIMITS,
  RELAY_CLOSE_CODE,
  RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS,
  RELAY_HOST_CAPABILITY_IDLE_REGIONAL_REHOME,
  RELAY_PROTOCOL_LIMITS
} from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { RelayStoreError, type RelayCredentialStore } from './credential-store.js'
import { CONTROL_RENEWAL_BATCH_INTERVAL_MS } from './control-renewal-batch.js'
import {
  type ControlRenewalOutcome,
  type ControlRenewalRequest
} from './control-renewal-statement.js'
import {
  HostSessionRegistry,
  IDLE_REHOME_MIN_CONTROL_AGE_MS,
  type HostSession
} from './host-session-registry.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import {
  REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
  REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
  REGIONAL_REHOME_TRUST_PROBE_USER_ID
} from './regional-rehome-trust-probe.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

// A due renewal leaves the heartbeat as a batch enqueue, so the store only sees
// the tick once the batch window closes.
async function closeRenewalWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)
}

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

type ActivateSession = (
  socket: WebSocket,
  identity: RelayTokenClaims,
  existing: HostSession | null,
  generation: number,
  rebind: boolean,
  assignmentEpoch: number,
  appVersion?: string
) => Promise<void>

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
    {
      id: 'production-gce-c3',
      url: 'https://relay-c3.example.com',
      capacityRequests: 4_000
    }
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

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function createRegistry(
  activateControl: RelayAssignmentStore['activateControl'],
  store: Partial<RelayCredentialStore> = {},
  verifyRelayToken: (token: string) => Promise<RelayTokenClaims | null> = vi.fn()
): {
  registry: HostSessionRegistry
  activate: ActivateSession
  acquireActivity: ReturnType<typeof vi.fn>
  renewControlActivities: ReturnType<typeof vi.fn<RelayAssignmentStore['renewControlActivities']>>
  releaseActivity: ReturnType<typeof vi.fn>
  observer: {
    recordAuth: ReturnType<typeof vi.fn>
    recordControlClose: ReturnType<typeof vi.fn>
    recordPostProofClose: ReturnType<typeof vi.fn>
    recordSpliceClose: ReturnType<typeof vi.fn>
  }
} {
  const acquireActivity = vi.fn().mockResolvedValue(undefined)
  const releaseActivity = vi.fn().mockResolvedValue(true)
  const renewControlActivities = vi
    .fn<RelayAssignmentStore['renewControlActivities']>()
    .mockImplementation(async (rows) => rows.map(() => 'renewed'))
  const assignments = {
    activateControl,
    markMigrationTargetRegistered: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue({ cellId: config.cellId }),
    acquireActivity,
    renewControlActivities,
    releaseActivity
  } as unknown as RelayAssignmentStore
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordControlClose: vi.fn(),
    recordPostProofClose: vi.fn(),
    recordSpliceClose: vi.fn()
  } satisfies RelayRuntimeObserver
  const registry = new HostSessionRegistry(
    config,
    verifyRelayToken,
    store as RelayCredentialStore,
    assignments,
    new ProcessQueuedByteBudget(),
    observer,
    Date.now,
    Math.random,
    'incarnation-1'
  )
  // Mirrors the production signature exactly so a future positional shift fails to compile.
  const bound = (
    registry as unknown as {
      activate: (
        socket: WebSocket,
        identity: RelayTokenClaims,
        existing: HostSession | null,
        generation: number,
        rebind: boolean,
        assignmentEpoch: number,
        appVersion: string,
        connectionInclusionWatermark?: number
      ) => Promise<void>
    }
  ).activate.bind(registry)
  const activate: ActivateSession = (
    socket,
    identity,
    existing,
    generation,
    rebind,
    assignmentEpoch,
    appVersion = '1.4.173'
  ) => bound(socket, identity, existing, generation, rebind, assignmentEpoch, appVersion)
  return {
    registry,
    activate,
    acquireActivity,
    renewControlActivities,
    releaseActivity,
    observer
  }
}

describe('host session cleanup races', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('logs control closes with a host digest and counts them, never the raw id', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { activate, observer } = createRegistry(activateControl)
    const socket = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
      socket.emit('error', new RangeError('Max payload size exceeded'))
      socket.close(1006, 'network reset')

      expect(observer.recordControlClose).toHaveBeenCalledWith(1006)
      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('control closed'))
      expect(line).toContain(`host=${relayHostLogDigest(identity.relayHostId)}`)
      expect(line).toContain('code=1006')
      expect(line).toContain('Max payload size exceeded')
      expect(line).not.toContain(identity.relayHostId)
    } finally {
      warn.mockRestore()
    }
  })

  it('contains a dependency failure to one socket instead of the process', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    // The same rejection shape as a pg-pool connect timeout; unguarded, it
    // became an unhandled rejection that crashed whole production cells.
    const verifyRelayToken = vi.fn(async (): Promise<RelayTokenClaims | null> => {
      throw new Error('Connection terminated due to connection timeout')
    })
    const { activate } = createRegistry(activateControl, {}, verifyRelayToken)
    const socket = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await activate(socket as unknown as WebSocket, identity, null, 1, false, 7)
      socket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'auth-refresh', relayJwt: 'refreshed' })),
        false
      )
      await vi.waitFor(() =>
        expect(socket.close).toHaveBeenCalledWith(
          RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
          'relay temporarily unavailable'
        )
      )
      expect(warn).toHaveBeenCalledWith(
        '[orca-relay] auth refresh failed: Connection terminated due to connection timeout'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('attributes a control close to its client build without trusting the version string', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { activate } = createRegistry(activateControl)
    const socket = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A client controls this string, so it must be bounded and stripped like any close reason.
      await activate(
        socket as unknown as WebSocket,
        identity,
        null,
        1,
        false,
        1,
        `1.4.173\n${'x'.repeat(200)}`
      )
      socket.close(4408, 'replaced by a newer generation')

      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('control closed'))
      expect(line).toContain('app="1.4.173')
      // The raw newline is escaped by JSON.stringify either way; only its escaped
      // form proves the strip ran, so assert on that.
      expect(line).not.toContain('\\n')
      expect(line).toMatch(/app="[^"]{1,80}"/)
    } finally {
      warn.mockRestore()
    }
  })

  it('reports the work a generation replacement destroyed, not the drained aftermath', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(activateControl, {
      failReservation: vi.fn().mockResolvedValue(undefined)
    })
    const firstSocket = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await activate(firstSocket as unknown as WebSocket, identity, null, 1, false, 1)
      const session = registry.get({
        userId: identity.sub,
        relayHostId: identity.relayHostId
      })!
      // Teardown drains both maps before closing the socket, so a close handler that
      // reads them live always reports zero regardless of what was actually killed.
      session.activeSplices.set('conn-a', () => session.activeSplices.delete('conn-a'))
      session.activeSplices.set('conn-b', () => session.activeSplices.delete('conn-b'))
      const clientSocket = new FakeSocket()
      session.pendingConns.set('conn-c', {
        connId: 'conn-c',
        connTicket: 'ticket',
        reservation: { userId: identity.sub, relayHostId: identity.relayHostId },
        client: clientSocket as unknown as WebSocket,
        attachTimer: setTimeout(() => {}, 60_000),
        credentialActivityId: null
      } as unknown as Parameters<typeof session.pendingConns.set>[1])

      const secondSocket = new FakeSocket()
      await activate(secondSocket as unknown as WebSocket, identity, session, 2, false, 1)

      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('replaced by a newer generation'))
      expect(line).toContain('splices=2')
      expect(line).toContain('pending=1')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps the first drain snapshot when a drain is retried', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(activateControl)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    // Captured before draining, because teardown removes the session from the map.
    const session = registry.get({
      userId: identity.sub,
      relayHostId: identity.relayHostId
    })!
    session.activeSplices.set('conn-a', () => session.activeSplices.delete('conn-a'))

    // POST /v1/admin/drain has no idempotency guard, and SIGTERM then SIGINT both
    // reach drain(), so a retry re-sends to every session. It must re-arm the pending
    // teardown rather than stack a second one: across a paced cell that is 800 orphaned
    // timers per retry, each one holding the loop open for the rest of the window.
    registry.drain(0)
    const scheduled = vi.getTimerCount()
    registry.drain(0)
    // Compare against the count before the retry rather than an absolute, since the
    // session's heartbeat interval is also pending.
    expect(vi.getTimerCount()).toBe(scheduled)
    vi.advanceTimersByTime(1)

    // Asserting registry state, not the log line: FakeSocket closes synchronously, so
    // the line is already emitted before the second teardown runs and would pass either way.
    expect(session.closingCounts).toEqual({ splices: 1, pending: 0 })
  })

  it('drains only the incarnation-bound host and makes replay idempotent', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(
      activateControl,
      {},
      vi.fn(async () => identity)
    )
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const secondIdentity = {
      ...identity,
      sub: 'user-2',
      relayHostId: 'ponmlkjihgfedcba'
    }
    await activate(firstSocket as unknown as WebSocket, identity, null, 1, false, 7)
    await activate(secondSocket as unknown as WebSocket, secondIdentity, null, 1, false, 3)
    const trustProbe = {
      attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
      userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
      relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    }
    expect(registry.get(trustProbe)).toBeNull()
    expect(registry.drainHost(trustProbe)).toBe('host-not-connected')
    expect(registry.drainHost(trustProbe)).toBe('host-not-connected')
    expect(firstSocket.send).not.toHaveBeenCalledWith(expect.stringContaining('"drain"'))
    expect(secondSocket.send).not.toHaveBeenCalledWith(expect.stringContaining('"drain"'))
    const request = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      userId: identity.sub,
      relayHostId: identity.relayHostId,
      sourceAssignmentEpoch: 7,
      graceMs: 30_000
    }

    expect(registry.drainHost(request)).toBe('accepted')
    expect(firstSocket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'drain', graceMs: 30_000, recovery: 'resolve-director' })
    )
    expect(secondSocket.send).not.toHaveBeenCalledWith(expect.stringContaining('"drain"'))
    firstSocket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'auth-refresh', relayJwt: 'refreshed' })),
      false
    )
    await vi.waitFor(() => expect(registry.get(request)?.state).toBe('drain-only'))
    const timers = vi.getTimerCount()
    expect(registry.drainHost(request)).toBe('already-accepted')
    expect(vi.getTimerCount()).toBe(timers)
    expect(() =>
      registry.drainHost({
        ...request,
        attemptId: '22222222-2222-4222-8222-222222222222'
      })
    ).toThrow('regional_rehome_attempt_conflict')
    expect(() => registry.drainHost({ ...request, sourceAssignmentEpoch: 8 })).toThrow(
      'regional_rehome_assignment_epoch_mismatch'
    )

    const rebound = new FakeSocket()
    await activate(rebound as unknown as WebSocket, identity, registry.get(request), 1, true, 7)
    expect(registry.get(request)?.state).toBe('drain-only')
    expect(rebound.send).toHaveBeenCalledWith(expect.stringContaining('"type":"drain"'))

    await vi.advanceTimersByTimeAsync(30_000)
    expect(registry.get(request)).toBeNull()
    expect(
      registry.get({ userId: secondIdentity.sub, relayHostId: secondIdentity.relayHostId })
    ).not.toBeNull()
    expect(secondSocket.close).not.toHaveBeenCalled()
  })

  it('refreshes the logged client build when a control rebinds', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(activateControl)
    const firstSocket = new FakeSocket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await activate(firstSocket as unknown as WebSocket, identity, null, 1, false, 1, '1.4.100')
      const session = registry.get({
        userId: identity.sub,
        relayHostId: identity.relayHostId
      })!
      const rebindSocket = new FakeSocket()
      await activate(rebindSocket as unknown as WebSocket, identity, session, 1, true, 1, '1.4.200')

      // The rebind closes the predecessor. That line is a churn line, so it must carry the
      // build that socket ran, not the successor's — the refresh above lands before it closes.
      const rebound = warn.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('control rebound'))
      expect(rebound).toContain('app="1.4.100"')

      rebindSocket.close(1006, 'network reset')
      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((entry) => entry.includes('code=1006'))
      expect(line).toContain('app="1.4.200"')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps every live control socket indexed when first activations overlap', async () => {
    const firstControl = deferred<string>()
    const secondControl = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockReturnValueOnce(firstControl.promise)
      .mockReturnValueOnce(secondControl.promise)
    const { registry, activate } = createRegistry(activateControl)
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()

    const first = activate(firstSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const second = activate(secondSocket as unknown as WebSocket, identity, null, 1, false, 1)
    secondControl.resolve('control:production-gce-c3:1')
    await Promise.resolve()
    firstControl.resolve('control:production-gce-c3:1')
    await Promise.all([first, second])

    const liveSockets = [firstSocket, secondSocket].filter(
      (socket) => socket.readyState === socket.OPEN
    )
    const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })
    expect(liveSockets).toHaveLength(1)
    expect(session?.socket).toBe(liveSockets[0])
  })

  it('does not publish a control that closes during activation', async () => {
    const blocked = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockReturnValueOnce(blocked.promise)
    const { registry, activate, releaseActivity } = createRegistry(activateControl)
    const socket = new FakeSocket()

    const activation = activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(activateControl).toHaveBeenCalledOnce()
    socket.close()
    blocked.resolve('control:production-gce-c3:1')
    await activation

    expect(registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })).toBeNull()
    expect(releaseActivity).toHaveBeenCalledWith(
      { userId: identity.sub, relayHostId: identity.relayHostId },
      'control:production-gce-c3:1'
    )
  })

  it('does not rebind a control that closes during activation', async () => {
    const blocked = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockReturnValueOnce(blocked.promise)
    const { registry, activate, releaseActivity } = createRegistry(activateControl)
    const originalSocket = new FakeSocket()
    await activate(originalSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const original = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })
    expect(original).not.toBeNull()

    const rebindSocket = new FakeSocket()
    const rebinding = activate(rebindSocket as unknown as WebSocket, identity, original, 1, true, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(activateControl).toHaveBeenCalledTimes(2)
    rebindSocket.close()
    blocked.resolve('control:production-gce-c3:1')
    await rebinding

    const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })
    expect(session).toBe(original)
    expect(session?.socket).toBe(originalSocket)
    expect(session?.state).toBe('active')
    expect(releaseActivity).toHaveBeenCalledWith(
      { userId: identity.sub, relayHostId: identity.relayHostId },
      'control:production-gce-c3:1'
    )
  })

  // The root of a seat c34's feed listed for hours: a rebind whose database activation outlived
  // the orphan grace revived the removed session outside the map, still listed and unreachable.
  it('refuses a rebind whose session left the map while its activation was in flight', async () => {
    const blocked = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockReturnValueOnce(blocked.promise)
    const { registry, activate, releaseActivity } = createRegistry(activateControl)
    const key = { userId: identity.sub, relayHostId: identity.relayHostId }
    const originalSocket = new FakeSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    await activate(originalSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const original = registry.get(key)
    originalSocket.close(1006, 'network reset')
    expect(original?.state).toBe('orphaned')

    const rebindSocket = new FakeSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    const rebinding = activate(rebindSocket as unknown as WebSocket, identity, original, 1, true, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(activateControl).toHaveBeenCalledTimes(2)
    // The grace runs out while the database answers slowly.
    await vi.advanceTimersByTimeAsync(CONTROL_CONTINUITY_LIMITS.orphanGraceMs)
    expect(registry.get(key)).toBeNull()
    blocked.resolve('control:production-gce-c3:1')
    await rebinding

    expect(rebindSocket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.PEER_DROPPED, 'control activation superseded')
    expect(registry.get(key)).toBeNull()
    expect(original?.state).toBe('closed')
    const page = registry.seatFeed(null)
    expect('full' in page && page.full).toEqual([])
    expect(releaseActivity).toHaveBeenCalledWith(key, 'control:production-gce-c3:1')
  })

  // Two hellos proven against the same empty map could take the same generation; an activation at
  // a generation this host already had here is refused, so a late leave cannot share it.
  it('refuses a fresh activation at a generation this host already had here', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:2')
    const { registry, activate } = createRegistry(activateControl)
    const key = { userId: identity.sub, relayHostId: identity.relayHostId }
    const first = new FakeSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    await activate(first as unknown as WebSocket, identity, null, 2, false, 1)
    first.close(1006, 'network reset')
    await vi.advanceTimersByTimeAsync(CONTROL_CONTINUITY_LIMITS.orphanGraceMs)
    expect(registry.get(key)).toBeNull()
    const reused = new FakeSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    await activate(reused as unknown as WebSocket, identity, null, 2, false, 1)
    expect(reused.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.PEER_DROPPED, 'control activation superseded')
    expect(registry.get(key)).toBeNull()
  })

  it('skips a closed queued control so its live retry avoids abandoned database work', async () => {
    const stalled = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockReturnValueOnce(stalled.promise)
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000))
        return 'control:production-gce-c3:1'
      })
    const { registry, activate, releaseActivity } = createRegistry(activateControl)
    const firstSocket = new FakeSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    const first = activate(firstSocket as unknown as WebSocket, identity, null, 1, false, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(activateControl).toHaveBeenCalledOnce()
    const abandonedSocket = new FakeSocket()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    const abandoned = activate(abandonedSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const liveSocket = new FakeSocket()
    const startedAt = Date.now()
    let liveCompletedAt: number | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSocket implements the registry's WebSocket event and lifecycle surface.
    const live = activate(liveSocket as unknown as WebSocket, identity, null, 1, false, 1)
      .then(() => { liveCompletedAt = Date.now() })
    firstSocket.close()
    abandonedSocket.close()
    stalled.resolve('control:production-gce-c3:1')
    await vi.advanceTimersByTimeAsync(8_000)
    await Promise.all([first, abandoned, live])

    console.log(JSON.stringify({
      scenario: 'closed queued control before a live retry',
      activationCalls: activateControl.mock.calls.length,
      activityReleases: releaseActivity.mock.calls.length,
      liveReadyMs: liveCompletedAt === undefined ? null : liveCompletedAt - startedAt
    }))
    expect(activateControl).toHaveBeenCalledTimes(2)
    expect(releaseActivity).toHaveBeenCalledOnce()
    expect(liveCompletedAt! - startedAt).toBe(4_000)
    expect(registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })?.socket)
      .toBe(liveSocket)
  })

  it('rejects client lookup when the indexed control socket is not open', async () => {
    const reservation = {
      userId: identity.sub,
      relayHostId: identity.relayHostId,
      credentialKind: 'resume',
      relayDeviceId: 'device-1',
      leaseExpiresAt: Date.now() + 60_000
    }
    const store = {
      resolveResume: vi.fn().mockResolvedValue({ userId: identity.sub }),
      reserveCredential: vi.fn().mockResolvedValue(reservation),
      failReservation: vi.fn().mockResolvedValue(undefined)
    }
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(activateControl, store)
    const controlSocket = new FakeSocket()
    await activate(controlSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })
    expect(session?.state).toBe('active')
    // A dead socket that never delivered its close event: state stays active,
    // so only the readyState guard can protect the lookup.
    controlSocket.readyState = controlSocket.CLOSED

    const client = new FakeSocket()
    await registry.acceptClient(client as unknown as WebSocket, identity.relayHostId, 'credential')

    expect(store.failReservation).toHaveBeenCalledWith(reservation)
    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'relay-hello', ok: false, code: RELAY_CLOSE_CODE.HOST_OFFLINE })
    )
    expect(session?.pendingConns.size).toBe(0)
  })

  it('fails a control waiting behind a stalled activation without breaking serialization', async () => {
    const stalled = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockReturnValueOnce(stalled.promise)
    const { registry, activate } = createRegistry(activateControl)
    const stalledSocket = new FakeSocket()
    const first = activate(stalledSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const waitingSocket = new FakeSocket()
    const second = activate(waitingSocket as unknown as WebSocket, identity, null, 1, false, 1)

    // Let the first activation reach the store (clearing its own queue timer)
    // before the waiting control's deadline elapses.
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(30_000)
    expect(waitingSocket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
      'control activation queue stalled'
    )
    // The waiting control never reached the store; serialization held.
    expect(activateControl).toHaveBeenCalledOnce()

    stalled.resolve('control:production-gce-c3:1')
    await Promise.all([first, second])
    const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })
    expect(session?.socket).toBe(stalledSocket)
    expect(session?.state).toBe('active')
  })

  it('rejects an activation that returns after drain begins', async () => {
    const blocked = deferred<string>()
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockReturnValueOnce(blocked.promise)
    const { registry, activate, renewControlActivities, releaseActivity } =
      createRegistry(activateControl)
    const originalSocket = new FakeSocket()
    await activate(originalSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const original = registry.get({
      userId: identity.sub,
      relayHostId: identity.relayHostId
    })
    expect(original).not.toBeNull()

    const replacementSocket = new FakeSocket()
    const replacement = activate(
      replacementSocket as unknown as WebSocket,
      identity,
      original,
      2,
      false,
      1
    )
    registry.drain(100)
    blocked.resolve('control:production-gce-c3:2')
    await replacement
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(15_000)

    expect(replacementSocket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'relay draining'
    )
    expect(registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })).toBeNull()
    expect(renewControlActivities).not.toHaveBeenCalled()
    expect(releaseActivity).toHaveBeenCalledWith(
      { userId: identity.sub, relayHostId: identity.relayHostId },
      'control:production-gce-c3:2'
    )
  })

  it('keeps a replacement mapped after stale orphan cleanup', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockResolvedValueOnce('control:production-gce-c3:2')
    const { registry, activate } = createRegistry(activateControl)
    const originalSocket = new FakeSocket()
    await activate(originalSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const original = registry.get({
      userId: identity.sub,
      relayHostId: identity.relayHostId
    })
    expect(original).not.toBeNull()
    originalSocket.close()

    const replacementSocket = new FakeSocket()
    await activate(replacementSocket as unknown as WebSocket, identity, original, 2, false, 1)
    const replacement = registry.get({
      userId: identity.sub,
      relayHostId: identity.relayHostId
    })
    vi.advanceTimersByTime(CONTROL_CONTINUITY_LIMITS.orphanGraceMs)

    expect(replacement).not.toBeNull()
    expect(registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })).toBe(
      replacement
    )
    expect(registry.runtimeCounts().controls).toBe(1)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('stops the heartbeat of an actively replaced generation', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockResolvedValueOnce('control:production-gce-c3:2')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const originalSocket = new FakeSocket()
    await activate(originalSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const original = registry.get({
      userId: identity.sub,
      relayHostId: identity.relayHostId
    })
    expect(original).not.toBeNull()

    await activate(new FakeSocket() as unknown as WebSocket, identity, original, 2, false, 1)
    await vi.advanceTimersByTimeAsync(15_000)
    await closeRenewalWindow()

    expect(renewControlActivities).toHaveBeenCalledOnce()
    expect(renewControlActivities).toHaveBeenCalledWith([
      expect.objectContaining({
        identity: { userId: identity.sub, relayHostId: identity.relayHostId },
        activityId: 'control:production-gce-c3:2',
        cellId: 'production-gce-c3'
      })
    ])
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('ignores a denial belonging to the socket before a same-generation rebind', async () => {
    const h = createRegistry(vi.fn().mockResolvedValue('control:production-gce-c3:1'))
    const oldSocket = new FakeSocket()
    await h.activate(oldSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const session = h.registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    let finish!: (outcomes: ControlRenewalOutcome[]) => void
    h.renewControlActivities.mockReturnValueOnce(
      new Promise<ControlRenewalOutcome[]>((resolve) => {
        finish = resolve
      })
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await closeRenewalWindow()
    const replacement = new FakeSocket()
    await h.activate(replacement as unknown as WebSocket, identity, session, 1, true, 1)
    finish(['activity_cell_not_authoritative'])
    await vi.advanceTimersByTimeAsync(0)
    expect(replacement.close).not.toHaveBeenCalled()
    expect(session.socket).toBe(replacement)
    expect(session.generation).toBe(1)
  })

  it('ignores missing-activity recovery denial after an authority transition', async () => {
    const h = createRegistry(vi.fn().mockResolvedValue('control:production-gce-c3:1'))
    const socket = new FakeSocket()
    await h.activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    const session = h.registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    h.renewControlActivities.mockResolvedValueOnce(['control_activity_not_found'])
    let reject!: (error: Error) => void
    h.acquireActivity.mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail
      })
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await closeRenewalWindow()
    h.registry.drainHost({
      attemptId: 'attempt',
      userId: identity.sub,
      relayHostId: identity.relayHostId,
      sourceAssignmentEpoch: 1,
      graceMs: 60_000
    })
    reject(new Error('activity_cell_not_authoritative'))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.close).not.toHaveBeenCalled()
    expect(session.state).toBe('drain-only')
  })

  it('keeps 15s pings while halving steady-state control renewals', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const socket = new FakeSocket()
    const activatedAt = Date.now()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    for (let interval = 0; interval < 4; interval++) {
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })), false)
      await closeRenewalWindow()
    }

    const pings = socket.send.mock.calls.filter((call) => String(call[0]).includes('"ping"'))
    expect(pings).toHaveLength(4)
    expect(renewControlActivities).toHaveBeenCalledTimes(2)
    const firstExpiry = Number(renewControlActivities.mock.calls[0]![0][0]!.expiresAt)
    const secondExpiry = Number(renewControlActivities.mock.calls[1]![0][0]!.expiresAt)
    expect(firstExpiry).toBe(
      activatedAt +
        RELAY_PROTOCOL_LIMITS.controlPingIntervalMs +
        ASSIGNMENT_LIMITS.activityLeaseMs +
        RELAY_PROTOCOL_LIMITS.controlPingIntervalMs
    )
    expect(secondExpiry - firstExpiry).toBe(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('retries a failed control renewal on the next ping', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    renewControlActivities.mockRejectedValueOnce(new Error('pool timeout'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const socket = new FakeSocket()
    try {
      await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      await closeRenewalWindow()
      expect(renewControlActivities).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      await closeRenewalWindow()
      expect(renewControlActivities).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
      registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })

  it('retries past a stalled control renewal without waiting for it', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const stalled = deferred<ControlRenewalOutcome[]>()
    renewControlActivities.mockReturnValueOnce(stalled.promise)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2)
    await closeRenewalWindow()

    expect(renewControlActivities).toHaveBeenCalledTimes(2)
    stalled.resolve(['renewed'])
    await vi.advanceTimersByTimeAsync(0)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('ignores a superseded renewal resolving after a fresher success', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const stalled = deferred<ControlRenewalOutcome[]>()
    renewControlActivities.mockReturnValueOnce(stalled.promise)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2)
    await closeRenewalWindow()
    expect(renewControlActivities).toHaveBeenCalledTimes(2)
    stalled.resolve(['renewed'])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    await closeRenewalWindow()

    expect(renewControlActivities).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    await closeRenewalWindow()

    expect(renewControlActivities).toHaveBeenCalledTimes(3)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('re-acquires a missing control activity lease', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, acquireActivity, renewControlActivities } =
      createRegistry(activateControl)
    renewControlActivities.mockResolvedValueOnce(['control_activity_not_found'])
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    await closeRenewalWindow()

    expect(acquireActivity).toHaveBeenCalledWith(
      { userId: identity.sub, relayHostId: identity.relayHostId },
      {
        activityId: 'control:production-gce-c3:1',
        kind: 'control',
        cellId: config.cellId
      }
    )
    expect(socket.close).not.toHaveBeenCalled()
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('closes a control whose activity lease moved to another cell', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, acquireActivity, renewControlActivities } =
      createRegistry(activateControl)
    renewControlActivities.mockResolvedValueOnce(['control_activity_moved'])
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    await closeRenewalWindow()

    expect(acquireActivity).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, 'control activity moved')
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('closes when a missing control activity cannot be re-acquired on this cell', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, acquireActivity, renewControlActivities } =
      createRegistry(activateControl)
    renewControlActivities.mockResolvedValueOnce(['control_activity_not_found'])
    acquireActivity.mockRejectedValueOnce(new Error('activity_cell_not_authoritative'))
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    await closeRenewalWindow()

    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'control migration completed'
    )
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('closes a control when renewal finds its cell is no longer authoritative', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    renewControlActivities.mockResolvedValueOnce(['activity_cell_not_authoritative'])
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    await closeRenewalWindow()

    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'control migration completed'
    )
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('continues renewing throughout the drain grace period', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    registry.drain(60_000)

    for (let interval = 0; interval < 3; interval++) {
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })), false)
      await closeRenewalWindow()
    }

    expect(renewControlActivities).toHaveBeenCalledTimes(2)
    expect(socket.readyState).toBe(socket.OPEN)
    vi.advanceTimersByTime(15_000)
  })
})

describe('control renewal cadence across a rebind', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps the halved cadence after a rebind lands under a stalled renewal', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const ping = RELAY_PROTOCOL_LIMITS.controlPingIntervalMs
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    const beat = async (target: FakeSocket): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ping)
      target.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })), false)
      await closeRenewalWindow()
    }

    // Age the session so its attempt counter is well above zero.
    for (let tick = 0; tick < 5; tick++) await beat(socket)
    expect(renewControlActivities).toHaveBeenCalledTimes(3)

    // The next renewal stalls and is still in flight when the control rebinds.
    const stalled = deferred<ControlRenewalOutcome[]>()
    renewControlActivities.mockReturnValueOnce(stalled.promise)
    for (let tick = 0; tick < 2; tick++) await beat(socket)
    expect(renewControlActivities).toHaveBeenCalledTimes(4)

    const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    const rebindSocket = new FakeSocket()
    await activate(rebindSocket as unknown as WebSocket, identity, session, 1, true, 1)
    stalled.resolve(['renewed'])
    await vi.advanceTimersByTimeAsync(0)

    const before = renewControlActivities.mock.calls.length
    for (let tick = 0; tick < 4; tick++) await beat(rebindSocket)
    expect(renewControlActivities.mock.calls.length - before).toBe(2)

    registry.drain(0)
    vi.advanceTimersByTime(0)
  })
})

describe('control renewals shared by one batch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('renews two due hosts in one call and leaves a stale one alone', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockResolvedValueOnce('control:production-gce-c3:1')
    const { registry, activate, renewControlActivities } = createRegistry(activateControl)
    const other = { ...identity, sub: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const staleSocket = new FakeSocket()
    const liveSocket = new FakeSocket()
    await activate(staleSocket as unknown as WebSocket, identity, null, 1, false, 1)
    await activate(liveSocket as unknown as WebSocket, other, null, 1, false, 1)
    const stale = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    const live = registry.get({ userId: other.sub, relayHostId: other.relayHostId })!

    // Both come due inside the same window, and one socket goes away while the
    // statement is still in PostgreSQL.
    let release!: () => void
    renewControlActivities.mockImplementationOnce(
      async (rows: readonly ControlRenewalRequest[]) => {
        staleSocket.close()
        await new Promise<void>((resolve) => (release = resolve))
        return rows.map((): ControlRenewalOutcome => 'renewed')
      }
    )
    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
    const staleDueAt = stale.activityRenewalDueAt
    await closeRenewalWindow()
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(renewControlActivities).toHaveBeenCalledOnce()
    expect(
      renewControlActivities.mock.calls[0]![0].map(
        (row: ControlRenewalRequest) => row.identity.relayHostId
      )
    ).toEqual([identity.relayHostId, other.relayHostId])
    expect(live.activityRenewalCompletedAttempt).toBe(1)
    expect(stale.activityRenewalCompletedAttempt).toBe(0)
    expect(stale.activityRenewalDueAt).toBe(staleDueAt)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })
})

describe('control lease recovery after the session is gone', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not re-acquire a lease for a session a newer generation already replaced', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValueOnce('control:production-gce-c3:1')
      .mockResolvedValueOnce('control:production-gce-c3:2')
    const { registry, activate, acquireActivity, renewControlActivities } =
      createRegistry(activateControl)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const socket = new FakeSocket()
      await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
      const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!

      // The renewal is still in flight when a newer generation takes over.
      let finishRenewal!: (outcomes: ControlRenewalOutcome[]) => void
      renewControlActivities.mockReturnValueOnce(
        new Promise<ControlRenewalOutcome[]>((resolve) => (finishRenewal = resolve))
      )
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      await closeRenewalWindow()
      expect(renewControlActivities).toHaveBeenCalledOnce()

      const newer = new FakeSocket()
      await activate(newer as unknown as WebSocket, identity, session, 2, false, 1)

      // Its release already removed the lease, so the renewal reports it missing.
      finishRenewal(['control_activity_not_found'])
      await vi.advanceTimersByTimeAsync(0)

      expect(acquireActivity).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })
})

describe('host hello ack pending connections', () => {
  const DETAILS = new Set([RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS])
  const LEGACY_ENTRY = { connId: 'conn-1', connTicket: 'T'.repeat(43) }
  const DETAILED_ENTRY = { ...LEGACY_ENTRY, kind: 'invite', relayDeviceId: 'device-1' }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function newRegistry(): ReturnType<typeof createRegistry> {
    return createRegistry(
      vi
        .fn<RelayAssignmentStore['activateControl']>()
        .mockResolvedValue('control:production-gce-c3:1')
    )
  }

  function addPendingConnection(session: HostSession): void {
    session.pendingConns.set('conn-1', {
      ...LEGACY_ENTRY,
      reservation: {
        userId: identity.sub,
        relayHostId: identity.relayHostId,
        credentialKind: 'invite',
        relayDeviceId: 'device-1'
      },
      client: new FakeSocket() as unknown as WebSocket,
      attachTimer: setTimeout(() => {}, 60_000),
      credentialActivityId: null
    } as unknown as Parameters<typeof session.pendingConns.set>[1])
  }

  function sentAck(socket: FakeSocket): Record<string, unknown> {
    const acks = socket.send.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((message) => message.type === 'host-hello-ack')
    return acks.at(-1)!
  }

  function sessionOf(registry: HostSessionRegistry): HostSession {
    return registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
  }

  async function ackFor(capabilities?: ReadonlySet<string>): Promise<Record<string, unknown>> {
    const { registry, activate } = newRegistry()
    const socket = new FakeSocket()
    registry.acceptControl(
      socket as unknown as WebSocket,
      identity,
      undefined,
      capabilities ?? new Set()
    )
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    const session = sessionOf(registry)
    addPendingConnection(session)
    socket.send.mockClear()
    ;(registry as unknown as { sendHelloAck(session: HostSession): void }).sendHelloAck(session)
    return sentAck(socket)
  }

  async function ackAfterRebind(
    first: ReadonlySet<string>,
    successor: ReadonlySet<string>
  ): Promise<{ opening: Record<string, unknown>; rebound: Record<string, unknown> }> {
    const { registry, activate } = newRegistry()
    const opening = new FakeSocket()
    registry.acceptControl(opening as unknown as WebSocket, identity, undefined, first)
    await activate(opening as unknown as WebSocket, identity, null, 1, false, 1)
    const session = sessionOf(registry)
    addPendingConnection(session)
    opening.send.mockClear()
    ;(registry as unknown as { sendHelloAck(session: HostSession): void }).sendHelloAck(session)

    const rebound = new FakeSocket()
    registry.acceptControl(rebound as unknown as WebSocket, identity, undefined, successor)
    await activate(rebound as unknown as WebSocket, identity, session, 1, true, 1)
    return { opening: sentAck(opening), rebound: sentAck(rebound) }
  }

  it('states the pending kind and device to a host that advertised it can read them', async () => {
    const ack = await ackFor(DETAILS)

    expect(ack.pendingConns).toEqual([DETAILED_ENTRY])
  })

  it('restates only the identifiers to a host that never advertised the capability', async () => {
    // A shipped host parses these entries strictly, so an unannounced key fails
    // the whole ack parse and kills a control that was working.
    const ack = await ackFor()

    expect(ack.pendingConns).toEqual([LEGACY_ENTRY])
  })

  it('downgrades the restated entry when the successor control drops the capability', async () => {
    // The capability belongs to the socket, not the session: a rebind can land a
    // control whose decoder is older than the one that opened the session.
    const { opening, rebound } = await ackAfterRebind(DETAILS, new Set())

    expect(opening.pendingConns).toEqual([DETAILED_ENTRY])
    expect(rebound.pendingConns).toEqual([LEGACY_ENTRY])
  })

  it('upgrades the restated entry when the successor control adds the capability', async () => {
    const { opening, rebound } = await ackAfterRebind(new Set(), DETAILS)

    expect(opening.pendingConns).toEqual([LEGACY_ENTRY])
    expect(rebound.pendingConns).toEqual([DETAILED_ENTRY])
  })
})

describe('source-owned idle cutover', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  const request = {
    attemptId: 'idle-1',
    userId: identity.sub,
    relayHostId: identity.relayHostId,
    sourceAssignmentEpoch: 1,
    sourceGeneration: 1,
    sourceCellIncarnation: 'incarnation-1',
    targetCellId: 'target'
  }
  async function source(
    store: Partial<RelayCredentialStore> = {},
    controlAgeMs = IDLE_REHOME_MIN_CONTROL_AGE_MS
  ) {
    const h = createRegistry(vi.fn().mockResolvedValue('control:1'), store)
    const socket = new FakeSocket()
    h.registry.acceptControl(
      socket as unknown as WebSocket,
      identity,
      undefined,
      new Set([RELAY_HOST_CAPABILITY_IDLE_REGIONAL_REHOME])
    )
    socket.removeAllListeners('message')
    await h.activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    // Moves the clock without firing the heartbeat timers that would close the session.
    vi.setSystemTime(Date.now() + controlAgeMs)
    return { ...h, socket, session: h.registry.get(request)! }
  }
  it.each([
    { controlAgeMs: 0, outcome: 'busy' },
    { controlAgeMs: IDLE_REHOME_MIN_CONTROL_AGE_MS - 1, outcome: 'busy' },
    { controlAgeMs: IDLE_REHOME_MIN_CONTROL_AGE_MS, outcome: 'committed' },
    { controlAgeMs: 60 * 60 * 1000, outcome: 'committed' }
  ])('answers $outcome for a control socket $controlAgeMs ms old', async (row) => {
    const { controlAgeMs, outcome } = row
    const h = await source({}, controlAgeMs)
    const commit = vi.fn().mockResolvedValue({ outcome: 'committed' })
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome })
    expect(commit).toHaveBeenCalledTimes(outcome === 'busy' ? 0 : 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.socket.close).toHaveBeenCalledTimes(outcome === 'busy' ? 0 : 1)
  })
  it('restarts the age when the host rebinds its control socket', async () => {
    const h = await source()
    const rebound = new FakeSocket()
    h.registry.acceptControl(
      rebound as unknown as WebSocket,
      identity,
      undefined,
      new Set([RELAY_HOST_CAPABILITY_IDLE_REGIONAL_REHOME])
    )
    rebound.removeAllListeners('message')
    await h.activate(rebound as unknown as WebSocket, identity, h.session, 1, true, 1)
    const commit = vi.fn().mockResolvedValue({ outcome: 'committed' })
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'busy' })
    expect(commit).not.toHaveBeenCalled()
  })
  it('closes a superseded socket whose refresh meets the cutover, not its successor', async () => {
    const h = await source()
    const successor = new FakeSocket()
    h.registry.acceptControl(
      successor as unknown as WebSocket,
      identity,
      undefined,
      new Set([RELAY_HOST_CAPABILITY_IDLE_REGIONAL_REHOME])
    )
    successor.removeAllListeners('message')
    await h.activate(successor as unknown as WebSocket, identity, h.session, 1, true, 1)
    vi.setSystemTime(Date.now() + IDLE_REHOME_MIN_CONTROL_AGE_MS)
    const commit = deferred<{ outcome: 'committed' }>()
    const cutover = h.registry.idleRehome(
      request,
      vi.fn(() => commit.promise),
      vi.fn().mockResolvedValue('not-committed')
    )
    h.socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth-refresh', relayJwt: 'jwt' })), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, 'resolve-director')
    expect(successor.close).not.toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, 'resolve-director')
    commit.resolve({ outcome: 'committed' })
    await cutover
  })
  it('keeps either established client busy until both actually leave', async () => {
    const h = await source()
    h.session.activeConnIds.add('phone')
    h.session.activeConnIds.add('ipad')
    const commit = vi.fn().mockResolvedValue({ outcome: 'committed' })
    h.session.activeConnIds.delete('ipad')
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'busy' })
    expect(commit).not.toHaveBeenCalled()
    h.session.activeConnIds.delete('phone')
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'committed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, expect.any(String))
    expect(h.releaseActivity).toHaveBeenCalled()
  })
  it.each([
    { userId: 'other-user' },
    { sourceAssignmentEpoch: 2 },
    { sourceGeneration: 2 },
    { sourceCellIncarnation: 'other-incarnation' },
    { targetCellId: 'other-target' }
  ])('rejects a reused operation ID with changed authority %j', async (change) => {
    const h = await source()
    const result = deferred<{ outcome: 'deferred' }>()
    const commit = vi.fn().mockReturnValue(result.promise)
    const reconcile = vi.fn().mockResolvedValue('not-committed')
    const moving = h.registry.idleRehome(request, commit, reconcile)
    const conflicting = h.registry.idleRehome({ ...request, ...change }, commit, reconcile)
    result.resolve({ outcome: 'deferred' })
    expect(await conflicting).toEqual({ outcome: 'stale' })
    expect(await moving).toEqual({ outcome: 'deferred' })
    expect(commit).toHaveBeenCalledOnce()
    expect(h.socket.close).not.toHaveBeenCalled()
  })
  it('accounts for accepts before credential identity resolves', async () => {
    const lookup = deferred<null>()
    const h = await source({
      resolveResume: vi.fn().mockReturnValue(lookup.promise),
      resolveInviteForMove: vi.fn().mockResolvedValue(null)
    })
    const client = new FakeSocket()
    const accept = h.registry.acceptClient(
      client as unknown as WebSocket,
      identity.relayHostId,
      'credential'
    )
    expect(
      await h.registry.idleRehome(request, vi.fn(), vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'busy' })
    lookup.resolve(null)
    await accept
    expect(h.socket.close).not.toHaveBeenCalled()
  })
  it('rejects new accepts and replacements synchronously while a commit awaits', async () => {
    const h = await source()
    const result = deferred<{ outcome: 'deferred' }>()
    const commit = vi.fn().mockReturnValue(result.promise)
    const moving = h.registry.idleRehome(
      request,
      commit,
      vi.fn().mockResolvedValue('not-committed')
    )
    const duplicate = h.registry.idleRehome(
      request,
      commit,
      vi.fn().mockResolvedValue('not-committed')
    )
    const client = new FakeSocket()
    const release = vi.fn()
    await h.registry.acceptClient(
      client as unknown as WebSocket,
      identity.relayHostId,
      'credential',
      { release } as never
    )
    expect(client.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, expect.any(String))
    expect(release).toHaveBeenCalledOnce()
    const replacement = new FakeSocket()
    await h.activate(replacement as unknown as WebSocket, identity, h.session, 2, false, 1)
    expect(replacement.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, expect.any(String))
    result.resolve({ outcome: 'deferred' })
    await moving
    await duplicate
    expect(commit).toHaveBeenCalledOnce()
    expect(h.socket.close).not.toHaveBeenCalled()
    expect(
      await h.registry.idleRehome(
        { ...request, attemptId: 'next' },
        vi.fn().mockResolvedValue({ outcome: 'committed' }),
        vi.fn().mockResolvedValue('not-committed')
      )
    ).toEqual({ outcome: 'committed' })
  })
  it.each(['ambiguous', 'deferred'])(
    'keeps %s outcomes fenced until locked reconciliation succeeds',
    async (claim) => {
      const h = await source()
      const reconcile = vi
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue('not-committed')
      const moving = h.registry.idleRehome(
        request,
        claim === 'ambiguous'
          ? vi.fn().mockRejectedValue(new Error('lost commit reply'))
          : vi.fn().mockResolvedValue({ outcome: 'deferred' }),
        reconcile
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(
        await h.registry.idleRehome(
          { ...request, attemptId: 'other' },
          vi.fn(),
          vi.fn().mockResolvedValue('not-committed')
        )
      ).toEqual({ outcome: 'busy' })
      expect(h.socket.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(await moving).toEqual({ outcome: 'deferred' })
      expect(reconcile).toHaveBeenCalledTimes(3)
      expect(h.socket.close).not.toHaveBeenCalled()
    }
  )
  it('owns accepted control mutations before the handler first awaits', async () => {
    const mutation = deferred<RelayTokenClaims | null>()
    const h = await source()
    ;(h.registry as unknown as { verifyRelayToken: unknown }).verifyRelayToken = vi
      .fn()
      .mockReturnValue(mutation.promise)
    h.socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'auth-refresh', relayJwt: 'token' })),
      false
    )
    const commit = vi.fn().mockResolvedValue({ outcome: 'deferred' })
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'busy' })
    mutation.resolve(identity)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'deferred' })
  })
  it('owns queued replacement activation before its first persistence await', async () => {
    const h = await source()
    const activation = deferred<string>()
    const assignments = (h.registry as unknown as { assignments: { activateControl: unknown } })
      .assignments
    assignments.activateControl = vi.fn().mockReturnValue(activation.promise)
    const replacement = new FakeSocket()
    const activating = h.activate(
      replacement as unknown as WebSocket,
      identity,
      h.session,
      2,
      false,
      1
    )
    expect(
      await h.registry.idleRehome(request, vi.fn(), vi.fn().mockResolvedValue('not-committed'))
    ).toEqual({ outcome: 'busy' })
    activation.resolve('control:2')
    await activating
  })
  it('retires changed authority even when the claim definitively deferred', async () => {
    const h = await source()
    expect(
      await h.registry.idleRehome(
        request,
        vi.fn().mockResolvedValue({ outcome: 'deferred' }),
        vi.fn().mockResolvedValue('stale')
      )
    ).toEqual({ outcome: 'stale' })
    expect(h.session.state).toBe('closed')
    expect(h.releaseActivity).toHaveBeenCalled()
  })
  it('holds attach ownership through basis failure reservation cleanup', async () => {
    const basis = deferred<void>()
    const cleanup = deferred<void>()
    const h = await source({
      recordConnectionBasis: vi.fn().mockImplementation(async () => {
        await basis.promise
        throw new Error('basis failed')
      }),
      failReservation: vi.fn().mockReturnValue(cleanup.promise)
    })
    const client = new FakeSocket()
    h.session.pendingConns.set('conn', {
      connId: 'conn',
      connTicket: 'ticket',
      client: client as unknown as WebSocket,
      reservation: {
        userId: identity.sub,
        relayHostId: identity.relayHostId,
        credentialKind: 'invite',
        relayDeviceId: 'device-1',
        tokenHash: 'invite-hash',
        reservationId: 'reservation-1',
        leaseExpiresAt: Date.now() + 1000
      },
      attachTimer: setTimeout(() => {}, 1000),
      credentialActivityId: null,
      phonePath: 'db',
      timing: {
        startedAt: Date.now(),
        connOpenAt: Date.now(),
        stageMs: { assignment: 0, credential: 0, activity: 0 }
      }
    })
    const attached = h.registry.acceptHostData(
      new FakeSocket() as unknown as WebSocket,
      'conn',
      'ticket',
      1
    )
    const commit = vi.fn().mockResolvedValue({ outcome: 'deferred' })
    expect(await h.registry.idleRehome(request, commit, vi.fn())).toEqual({ outcome: 'busy' })
    basis.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.session.activeConnIds.size).toBe(0)
    expect(await h.registry.idleRehome(request, commit, vi.fn())).toEqual({ outcome: 'busy' })
    expect(commit).not.toHaveBeenCalled()
    cleanup.resolve()
    await attached
  })
  it('rejects an attach mid-cutover before its ticket is ever examined', async () => {
    const h = await source({ failReservation: vi.fn().mockResolvedValue(undefined) })
    const result = deferred<{ outcome: 'deferred' }>()
    // The cutover must already be in flight: an idle host is what it claims.
    const moving = h.registry.idleRehome(request, () => result.promise, vi.fn())
    const client = new FakeSocket()
    h.session.pendingConns.set('conn', {
      connId: 'conn',
      connTicket: 'ticket',
      client: client as unknown as WebSocket,
      reservation: {
        userId: identity.sub,
        relayHostId: identity.relayHostId,
        credentialKind: 'invite',
        leaseExpiresAt: Date.now() + 1000
      },
      attachTimer: setTimeout(() => {}, 1000),
      credentialActivityId: null
    } as never)
    const host = new FakeSocket()
    // The ticket below is the live one: only the cutover fence may reject it.
    expect(
      await h.registry.acceptHostData(host as unknown as WebSocket, 'conn', 'ticket', 1)
    ).toBe(false)
    expect(host.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, expect.any(String))
    expect(h.observer.recordAuth).not.toHaveBeenCalled()
    expect(h.session.pendingConns.has('conn')).toBe(true)
    expect(h.session.activeConnIds.size).toBe(0)
    result.resolve({ outcome: 'deferred' })
    await moving
  })
  it('holds no attach ownership when no session owns the connection', async () => {
    const h = await source()
    const host = new FakeSocket()
    expect(
      await h.registry.acceptHostData(host as unknown as WebSocket, 'stranger', 'ticket', 1)
    ).toBe(false)
    expect(h.observer.recordAuth).toHaveBeenCalledWith(false)
    expect(host.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      expect.any(String)
    )
    // A leaked idle-work hold from the unowned attach would report `busy` here.
    expect(
      await h.registry.idleRehome(
        request,
        vi.fn().mockResolvedValue({ outcome: 'committed' }),
        vi.fn()
      )
    ).toEqual({ outcome: 'committed' })
  })
  it('returns the durable operation outcome after source retirement', async () => {
    const h = await source()
    const commit = vi.fn().mockResolvedValue({ outcome: 'committed' })
    await h.registry.idleRehome(request, commit, vi.fn())
    expect(
      await h.registry.idleRehome(request, commit, vi.fn().mockResolvedValue('committed'))
    ).toEqual({ outcome: 'committed' })
    expect(commit).toHaveBeenCalledOnce()
  })
  it('does not reopen a source overtaken by emergency drain', async () => {
    const h = await source()
    const result = deferred<{ outcome: 'deferred' }>()
    const moving = h.registry.idleRehome(
      request,
      () => result.promise,
      vi.fn().mockResolvedValue('not-committed')
    )
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    result.resolve({ outcome: 'deferred' })
    await moving
    expect(h.session.state).toBe('closed')
    expect(h.registry.get(request)).toBeNull()
  })
})

// The host data leg's owner lookup is the registry's only whole-inventory scan on
// an attach. These count what that scan touches, not how long it takes.
describe('host data attach owner lookup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const SESSION_COUNT = 1000
  const CONN_ID = 'conn-owned'
  const OWNER_INDEX = { first: 0, middle: 499, last: 999 } as const
  type Placement = keyof typeof OWNER_INDEX | 'absent'
  type LookupCounts = { visits: number; membership: number }

  function bindOwn<K, V>(map: Map<K, V>, property: string | symbol): unknown {
    const value: unknown = Reflect.get(map, property, map)
    return typeof value === 'function' ? value.bind(map) : value
  }

  // One visit per session the scan pulls off the map iterator; answers unchanged.
  function countingValues<K, V>(map: Map<K, V>, counts: LookupCounts): Map<K, V> {
    return new Proxy(map, {
      get(target, property) {
        if (property !== 'values') return bindOwn(target, property)
        return function* (): Generator<V> {
          for (const value of target.values()) {
            counts.visits += 1
            yield value
          }
        }
      }
    })
  }

  // One membership check per `pendingConns.has`; answers unchanged.
  function countingHas<K, V>(map: Map<K, V>, counts: LookupCounts): Map<K, V> {
    return new Proxy(map, {
      get(target, property) {
        if (property !== 'has') return bindOwn(target, property)
        return (key: K) => {
          counts.membership += 1
          return target.has(key)
        }
      }
    })
  }

  function pendingConn(
    client: FakeSocket,
    connTicket: string
  ): NonNullable<ReturnType<HostSession['pendingConns']['get']>> {
    return {
      connId: CONN_ID,
      connTicket,
      client: client as unknown as WebSocket,
      reservation: {
        userId: identity.sub,
        relayHostId: identity.relayHostId,
        credentialKind: 'invite',
        relayDeviceId: 'device-1',
        tokenHash: 'invite-hash',
        reservationId: 'reservation-1',
        leaseExpiresAt: Date.now() + 1000
      },
      attachTimer: setTimeout(() => {}, 1000),
      credentialActivityId: null,
      phonePath: 'db',
      timing: {
        startedAt: Date.now(),
        connOpenAt: Date.now(),
        stageMs: { assignment: 0, credential: 0, activity: 0 }
      }
    }
  }

  // Every decoy holds a pending conn of its own, so each membership check the
  // scan makes is real work rather than a lookup in an empty map.
  function decoySession(index: number, counts: LookupCounts): HostSession {
    const pendingConns = new Map<string, unknown>([[`conn-decoy-${index}`, { connId: 'decoy' }]])
    return {
      relayHostId: `decoy-host-${index}`,
      generation: 1,
      state: 'active',
      activeConnIds: new Set<string>(),
      pendingConns: countingHas(pendingConns, counts)
    } as unknown as HostSession
  }

  async function attachRegistry(placement: Placement, store: Partial<RelayCredentialStore> = {}) {
    const h = createRegistry(vi.fn().mockResolvedValue('control:1'), {
      failReservation: vi.fn().mockResolvedValue(undefined),
      recordConnectionBasis: vi.fn().mockResolvedValue(undefined),
      deactivateBasis: vi.fn().mockResolvedValue(undefined),
      ...store
    })
    const control = new FakeSocket()
    await h.activate(control as unknown as WebSocket, identity, null, 1, false, 1)
    const internals = h.registry as unknown as { sessions: Map<string, HostSession> }
    const [ownerKey, owner] = [...internals.sessions.entries()][0]!
    const counts: LookupCounts = { visits: 0, membership: 0 }
    const client = new FakeSocket()
    if (placement !== 'absent') owner.pendingConns.set(CONN_ID, pendingConn(client, 'ticket'))
    owner.pendingConns = countingHas(owner.pendingConns, counts)
    const ordered: HostSession[] = []
    const sessions = new Map<string, HostSession>()
    const ownerIndex = placement === 'absent' ? 0 : OWNER_INDEX[placement]
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      const session = index === ownerIndex ? owner : decoySession(index, counts)
      ordered.push(session)
      sessions.set(index === ownerIndex ? ownerKey : `decoy-${index}`, session)
    }
    internals.sessions = countingValues(sessions, counts)
    return { ...h, owner, ordered, counts, client, control, sessions: internals.sessions }
  }

  it.each([
    {
      placement: 'first',
      after: { visits: 1, membership: 1 }
    },
    {
      placement: 'middle',
      after: { visits: 500, membership: 500 }
    },
    {
      placement: 'last',
      after: { visits: 1000, membership: 1000 }
    },
    {
      placement: 'absent',
      after: { visits: 1000, membership: 1000 }
    }
  ] as const)(
    'visits the inventory once, not twice, for a $placement owner',
    async ({ placement, after }) => {
      const h = await attachRegistry(placement)
      expect(h.sessions.size).toBe(SESSION_COUNT)
      h.counts.visits = 0
      h.counts.membership = 0
      const host = new FakeSocket()
      // An unusable ticket stops the attach immediately after the lookup, so the
      // counts below belong to the lookup alone.
      expect(
        await h.registry.acceptHostData(host as unknown as WebSocket, CONN_ID, 'wrong', 1)
      ).toBe(false)
      expect(h.observer.recordAuth).toHaveBeenCalledExactlyOnceWith(false)
      expect(host.close).toHaveBeenCalledWith(
        RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
        'invalid host data ticket'
      )
      expect({ ...h.counts }).toEqual(after)
    }
  )

  it.each([
    { reason: 'ticket', ticket: 'wrong', generation: 1, state: 'active' },
    { reason: 'generation', ticket: 'ticket', generation: 2, state: 'active' },
    { reason: 'state', ticket: 'ticket', generation: 1, state: 'orphaned' }
  ] as const)('fails an attach whose $reason does not match the owner', async (input) => {
    const h = await attachRegistry('middle')
    h.owner.state = input.state
    const host = new FakeSocket()
    expect(
      await h.registry.acceptHostData(
        host as unknown as WebSocket,
        CONN_ID,
        input.ticket,
        input.generation
      )
    ).toBe(false)
    expect(h.observer.recordAuth).toHaveBeenCalledExactlyOnceWith(false)
    expect(host.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'invalid host data ticket'
    )
    expect(h.owner.pendingConns.has(CONN_ID)).toBe(true)
    expect(h.owner.activeConnIds.size).toBe(0)
  })

  it('rejects on the earlier duplicate owner rather than the later live one', async () => {
    const h = await attachRegistry('middle')
    h.ordered[0]!.pendingConns.set(CONN_ID, pendingConn(new FakeSocket(), 'stale-ticket') as never)
    h.counts.visits = 0
    h.counts.membership = 0
    const host = new FakeSocket()
    expect(
      await h.registry.acceptHostData(host as unknown as WebSocket, CONN_ID, 'ticket', 1)
    ).toBe(false)
    expect({ ...h.counts }).toEqual({ visits: 1, membership: 1 })
    expect(h.owner.pendingConns.has(CONN_ID)).toBe(true)
  })

  it('consumes the earlier duplicate owner on basis failure and leaves the later one untouched', async () => {
    const basis = vi.fn().mockRejectedValue(new Error('basis failed'))
    const h = await attachRegistry('first', { recordConnectionBasis: basis })
    const duplicate = h.ordered[3]!
    duplicate.pendingConns.set(CONN_ID, pendingConn(new FakeSocket(), 'ticket') as never)
    h.counts.visits = 0
    h.counts.membership = 0
    const host = new FakeSocket()
    expect(
      await h.registry.acceptHostData(host as unknown as WebSocket, CONN_ID, 'ticket', 1)
    ).toBe(false)
    expect({ ...h.counts }).toEqual({ visits: 1, membership: 1 })
    expect(h.observer.recordAuth).toHaveBeenCalledWith(true)
    expect(basis).toHaveBeenCalledOnce()
    // The first owner's entry was consumed; the later duplicate never was.
    expect(h.owner.pendingConns.has(CONN_ID)).toBe(false)
    expect(duplicate.pendingConns.has(CONN_ID)).toBe(true)
    expect(h.owner.activeConnIds.size).toBe(0)
  })
})

describe('paced drain', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function connectHosts(count: number): Promise<{
    registry: HostSessionRegistry
    sockets: FakeSocket[]
  }> {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(activateControl)
    const sockets: FakeSocket[] = []
    for (let index = 0; index < count; index += 1) {
      const socket = new FakeSocket()
      sockets.push(socket)
      await activate(
        socket as unknown as WebSocket,
        { ...identity, sub: `user-${index}` },
        null,
        1,
        false,
        1
      )
      socket.send.mockClear()
    }
    return { registry, sockets }
  }

  function drainsSent(sockets: FakeSocket[]): number {
    return sockets.filter((socket) =>
      socket.send.mock.calls.some(([payload]) => String(payload).includes('"type":"drain"'))
    ).length
  }

  it('sends every drain at once when no window is given', async () => {
    const { registry, sockets } = await connectHosts(4)
    registry.drain(0)
    // A zero-grace drain is told by its close, once the host's release has landed.
    await vi.advanceTimersByTimeAsync(0)
    expect(drainsSent(sockets)).toBe(4)
  })

  // Windows here stay under the 75s control-silence watchdog, which would otherwise close
  // a test socket that never heartbeats before its paced send is due.
  it('spreads the sends evenly across the window', async () => {
    const { registry, sockets } = await connectHosts(5)
    registry.drain(0, { paceWindowMs: 40_000 })
    // Each host is told by its zero-grace close, which a timer nested in the send runs 1 ms on.
    const advance = async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms)
      await vi.advanceTimersByTimeAsync(1)
    }
    // The first host is told at once; the last lands on the window's closing edge.
    await advance(0)
    expect(drainsSent(sockets)).toBe(1)
    await advance(10_000)
    expect(drainsSent(sockets)).toBe(2)
    await advance(20_000)
    expect(drainsSent(sockets)).toBe(4)
    await advance(10_000)
    expect(drainsSent(sockets)).toBe(5)
  })

  it('refuses new host controls before the first paced send lands', async () => {
    const { registry, sockets } = await connectHosts(3)
    registry.drain(0, { paceWindowMs: 40_000 })
    expect(registry.isDraining()).toBe(true)
    // The fleet drain refuses newly arriving host controls immediately.
    const socket = new FakeSocket()
    registry.acceptControl(socket as unknown as WebSocket, { ...identity, sub: 'user-late' })
    expect(socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, 'relay draining')
    await vi.advanceTimersByTimeAsync(0)
    expect(drainsSent(sockets)).toBe(1)
  })

  it('gives each host its own grace after its own send, not after the call', async () => {
    const { registry, sockets } = await connectHosts(2)
    registry.drain(10_000, { paceWindowMs: 40_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets[0]!.readyState).toBe(sockets[0]!.CLOSED)
    expect(sockets[1]!.readyState).toBe(sockets[1]!.OPEN)
    // Its own send at 40s plus its own 10s grace, not 10s from the drain call.
    await vi.advanceTimersByTimeAsync(39_999)
    expect(sockets[1]!.readyState).toBe(sockets[1]!.OPEN)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets[1]!.readyState).toBe(sockets[1]!.CLOSED)
  })

  it('leaves no timer behind once an emergency drain cuts a window short', async () => {
    const { registry } = await connectHosts(4)
    registry.drain(0, { paceWindowMs: 40_000 })
    registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    // Every session is closed, so anything still pending is an orphan of the cut window.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the first teardown snapshot when a regional drain fires before the fleet one', async () => {
    const { registry, sockets } = await connectHosts(1)
    const session = registry.get({ userId: 'user-0', relayHostId: identity.relayHostId })!
    session.activeSplices.set('conn-a', () => session.activeSplices.delete('conn-a'))
    registry.drainHost({
      attemptId: 'attempt',
      userId: 'user-0',
      relayHostId: identity.relayHostId,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    })
    registry.drain(10)
    await vi.advanceTimersByTimeAsync(11)
    expect(session.closingCounts).toEqual({ splices: 1, pending: 0 })
    expect(sockets[0]!.readyState).toBe(sockets[0]!.CLOSED)
  })

  it('lets an emergency drain supersede the sends still queued by a paced one', async () => {
    const { registry, sockets } = await connectHosts(4)
    registry.drain(0, { paceWindowMs: 40_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(drainsSent(sockets)).toBe(1)
    registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(drainsSent(sockets)).toBe(4)
    const sendsAfterEmergency = sockets.map((socket) => socket.send.mock.calls.length)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(sockets.map((socket) => socket.send.mock.calls.length)).toEqual(sendsAfterEmergency)
  })
})

describe('controls closed after host proof but before wiring', () => {
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    vi.useFakeTimers()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  const refusedLines = (): string[] =>
    warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('control refused after proof'))

  function expectRefusal(
    observer: { recordPostProofClose: ReturnType<typeof vi.fn> },
    code: number | null,
    reason: string,
    cause?: string
  ): void {
    expect(observer.recordPostProofClose).toHaveBeenCalledWith(reason)
    const [line] = refusedLines()
    expect(line).toContain(`host=${relayHostLogDigest(identity.relayHostId)} gen=1 app="1.4.173"`)
    expect(line).toContain(`code=${code ?? 'none'} reason=${JSON.stringify(reason)}`)
    if (cause) expect(line).toContain(`cause=${cause}`)
    expect(line).not.toContain(identity.relayHostId)
    expect(line).not.toContain(identity.sub)
  }

  it('logs an idle cutover refusal', async () => {
    const h = createRegistry(vi.fn())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: beginIdleWork only checks the host key's presence.
    const idle = h.registry as unknown as { idleAttempts: Map<string, unknown> }
    idle.idleAttempts.set(identity.relayHostId, {})
    const socket = new FakeSocket()
    await h.activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.WRONG_CELL,
      'idle cutover in progress'
    )
    expectRefusal(h.observer, RELAY_CLOSE_CODE.WRONG_CELL, 'idle cutover in progress')
  })

  it('logs a stalled activation queue once', async () => {
    const stalled = deferred<string>()
    const h = createRegistry(
      vi.fn<RelayAssignmentStore['activateControl']>().mockReturnValueOnce(stalled.promise)
    )
    const first = h.activate(new FakeSocket() as unknown as WebSocket, identity, null, 1, false, 1)
    const waiting = new FakeSocket()
    const second = h.activate(waiting as unknown as WebSocket, identity, null, 1, false, 1)
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(30_000)
    expectRefusal(h.observer, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'control activation queue stalled')
    stalled.resolve('control:production-gce-c3:1')
    await Promise.all([first, second])
    expect(h.observer.recordPostProofClose).toHaveBeenCalledOnce()
  })

  it('logs a superseded activation', async () => {
    const h = createRegistry(vi.fn())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only compared by identity against the empty session map.
    const stale = {} as HostSession
    await h.activate(new FakeSocket() as unknown as WebSocket, identity, stale, 1, false, 1)
    expectRefusal(h.observer, RELAY_CLOSE_CODE.PEER_DROPPED, 'control activation superseded')
  })

  it.each([
    { error: new Error('wrong_assignment'), cause: 'wrong_assignment' },
    { error: Object.assign(new Error('timeout'), { code: '57014' }), cause: 'database_transient' },
    // Assembled at runtime so the secret scanner does not read the fixture as a real URL.
    {
      error: new Error(`connect ${['postgres', '//user:secret@db/relay'].join(':')}`),
      cause: 'error'
    }
  ])('logs a failed host-proof assignment check as $cause', async ({ error, cause }) => {
    const h = createRegistry(
      vi.fn<RelayAssignmentStore['activateControl']>().mockRejectedValueOnce(error)
    )
    await h.activate(new FakeSocket() as unknown as WebSocket, identity, null, 1, false, 1)
    expectRefusal(
      h.observer,
      RELAY_CLOSE_CODE.WRONG_CELL,
      'assignment changed during host proof',
      cause
    )
    expect(refusedLines()[0]).not.toContain('secret')
  })

  it('logs a drain that lands during activation', async () => {
    const h = createRegistry(vi.fn().mockResolvedValue('control:production-gce-c3:1'))
    h.registry.drain(100)
    await h.activate(new FakeSocket() as unknown as WebSocket, identity, null, 1, false, 1)
    expectRefusal(h.observer, RELAY_CLOSE_CODE.DRAINING, 'relay draining')
  })

  it('logs a host that hangs up during activation, with no cell close code', async () => {
    const blocked = deferred<string>()
    const h = createRegistry(
      vi.fn<RelayAssignmentStore['activateControl']>().mockReturnValueOnce(blocked.promise)
    )
    const socket = new FakeSocket()
    const activation = h.activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    await vi.advanceTimersByTimeAsync(0)
    socket.close()
    blocked.resolve('control:production-gce-c3:1')
    await activation
    expectRefusal(h.observer, null, 'host closed during activation')
  })

  it('logs a host that hangs up while queued, with no cell close code', async () => {
    const stalled = deferred<string>()
    const h = createRegistry(
      vi
        .fn<RelayAssignmentStore['activateControl']>()
        .mockReturnValueOnce(stalled.promise)
        .mockResolvedValue('control:production-gce-c3:1')
    )
    const first = h.activate(new FakeSocket() as unknown as WebSocket, identity, null, 1, false, 1)
    const queued = new FakeSocket()
    const second = h.activate(queued as unknown as WebSocket, identity, null, 1, false, 1)
    queued.close()
    stalled.resolve('control:production-gce-c3:1')
    await Promise.all([first, second])
    expectRefusal(h.observer, null, 'host closed while queued')
  })

  it('logs the hang-up, not a stall, when the queued host left before the deadline', async () => {
    const stalled = deferred<string>()
    const h = createRegistry(
      vi.fn<RelayAssignmentStore['activateControl']>().mockReturnValueOnce(stalled.promise)
    )
    const first = h.activate(new FakeSocket() as unknown as WebSocket, identity, null, 1, false, 1)
    const queued = new FakeSocket()
    const second = h.activate(queued as unknown as WebSocket, identity, null, 1, false, 1)
    await Promise.resolve()
    await Promise.resolve()
    queued.readyState = queued.CLOSED
    vi.advanceTimersByTime(30_000)
    expect(queued.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
      'control activation queue stalled'
    )
    expectRefusal(h.observer, null, 'host closed while queued')
    stalled.resolve('control:production-gce-c3:1')
    await Promise.all([first, second])
  })

  it('does not log a control that was wired', async () => {
    const h = createRegistry(vi.fn().mockResolvedValue('control:production-gce-c3:1'))
    await h.activate(new FakeSocket() as unknown as WebSocket, identity, null, 1, false, 1)
    expect(h.observer.recordPostProofClose).not.toHaveBeenCalled()
    expect(refusedLines()).toEqual([])
  })
})

describe('control error codes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function revokeFailure(error: Error): Promise<{ sent: string[]; warned: string[] }> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate } = createRegistry(activateControl, {
      revoke: vi.fn().mockRejectedValue(error)
    })
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'device-revoke', reqId: 'revoke-1', relayDeviceId: 'device-1' })),
      false
    )
    await vi.advanceTimersByTimeAsync(0)
    const sent = socket.send.mock.calls.map((call) => String(call[0]))
    const warned = warn.mock.calls.map((call) => String(call[0]))
    warn.mockRestore()
    registry.drain(0)
    vi.advanceTimersByTime(0)
    return { sent, warned }
  }

  function controlErrors(sent: string[]): unknown[] {
    return sent
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message.type === 'control-error')
  }

  it('never sends a database error message, which can carry the connection URL', async () => {
    // Assembled at runtime so secret scanners do not flag a fixture URL.
    const url = ['postgres', '://relay:', 'fake-pw', '@db.internal:5432/relay'].join('')
    const error = Object.assign(new Error(`connect to ${url} failed: Connection terminated`), {
      code: '08006'
    })
    const { sent, warned } = await revokeFailure(error)

    expect(controlErrors(sent)).toEqual([
      { type: 'control-error', reqId: 'revoke-1', code: 'database_transient' }
    ])
    expect(sent.join('\n')).not.toContain('fake-pw')
    expect(warned).toContain('[orca-relay] control device-revoke failed: Error: redacted code=08006')
    expect(warned.join('\n')).not.toContain('fake-pw')
  })

  it('maps any other unexpected message to a fixed code', async () => {
    const { sent } = await revokeFailure(new Error('Unexpected token < in JSON'))

    expect(controlErrors(sent)).toEqual([
      { type: 'control-error', reqId: 'revoke-1', code: 'control_operation_failed' }
    ])
  })

  it.each([
    ['a store code', new RelayStoreError('reject-revoked'), 'reject-revoked'],
    ['an invariant slug', new Error('authorization_expired'), 'authorization_expired']
  ])('keeps %s on the wire', async (_kind, error, code) => {
    const { sent, warned } = await revokeFailure(error)

    expect(controlErrors(sent)).toEqual([{ type: 'control-error', reqId: 'revoke-1', code }])
    expect(warned.join('\n')).not.toContain('control device-revoke failed')
  })
})
