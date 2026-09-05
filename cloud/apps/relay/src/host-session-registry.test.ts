import { EventEmitter } from 'node:events'
import {
  ASSIGNMENT_LIMITS,
  CONTROL_CONTINUITY_LIMITS,
  RELAY_CLOSE_CODE,
  RELAY_PROTOCOL_LIMITS
} from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { HostSessionRegistry, type HostSession } from './host-session-registry.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import {
  REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
  REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
  REGIONAL_REHOME_TRUST_PROBE_USER_ID
} from './regional-rehome-trust-probe.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

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
  renewControlActivity: ReturnType<typeof vi.fn>
  releaseActivity: ReturnType<typeof vi.fn>
  observer: {
    recordControlClose: ReturnType<typeof vi.fn>
    recordSpliceClose: ReturnType<typeof vi.fn>
  }
} {
  const acquireActivity = vi.fn().mockResolvedValue(undefined)
  const renewControlActivity = vi.fn().mockResolvedValue(undefined)
  const releaseActivity = vi.fn().mockResolvedValue(true)
  const assignments = {
    activateControl,
    markMigrationTargetRegistered: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue({ cellId: config.cellId }),
    acquireActivity,
    renewControlActivity,
    releaseActivity
  } as unknown as RelayAssignmentStore
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordControlClose: vi.fn(),
    recordSpliceClose: vi.fn()
  } satisfies RelayRuntimeObserver
  const registry = new HostSessionRegistry(
    config,
    verifyRelayToken,
    store as RelayCredentialStore,
    assignments,
    new ProcessQueuedByteBudget(),
    observer
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
  return { registry, activate, acquireActivity, renewControlActivity, releaseActivity, observer }
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
    // reach drain(), so a second teardown can be scheduled for the same session.
    registry.drain(0)
    const scheduled = vi.getTimerCount()
    registry.drain(0)
    // Pin the premise: if drain ever gains an idempotency guard, the retry schedules no
    // second teardown and the assertion below stops defending the write-once snapshot
    // while still passing. Compare against the count before the retry rather than an
    // absolute, since the session's heartbeat interval is also pending.
    expect(vi.getTimerCount()).toBe(scheduled + 1)
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
    expect(() =>
      registry.drainHost({ ...request, sourceAssignmentEpoch: 8 })
    ).toThrow('regional_rehome_assignment_epoch_mismatch')

    const rebound = new FakeSocket()
    await activate(
      rebound as unknown as WebSocket,
      identity,
      registry.get(request),
      1,
      true,
      7
    )
    expect(registry.get(request)?.state).toBe('drain-only')
    expect(rebound.send).toHaveBeenCalledWith(expect.stringContaining('"type":"drain"'))

    await vi.advanceTimersByTimeAsync(30_000)
    expect(registry.get(request)).toBeNull()
    expect(registry.get({ userId: secondIdentity.sub, relayHostId: secondIdentity.relayHostId }))
      .not.toBeNull()
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
    const rebinding = activate(
      rebindSocket as unknown as WebSocket,
      identity,
      original,
      1,
      true,
      1
    )
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
    const { registry, activate, renewControlActivity, releaseActivity } =
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
    expect(renewControlActivity).not.toHaveBeenCalled()
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
    await activate(
      replacementSocket as unknown as WebSocket,
      identity,
      original,
      2,
      false,
      1
    )
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
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    const originalSocket = new FakeSocket()
    await activate(originalSocket as unknown as WebSocket, identity, null, 1, false, 1)
    const original = registry.get({
      userId: identity.sub,
      relayHostId: identity.relayHostId
    })
    expect(original).not.toBeNull()

    await activate(
      new FakeSocket() as unknown as WebSocket,
      identity,
      original,
      2,
      false,
      1
    )
    vi.advanceTimersByTime(15_000)

    expect(renewControlActivity).toHaveBeenCalledOnce()
    expect(renewControlActivity).toHaveBeenCalledWith(
      { userId: identity.sub, relayHostId: identity.relayHostId },
      expect.objectContaining({
        activityId: 'control:production-gce-c3:2',
        cellId: 'production-gce-c3'
      })
    )
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('keeps 15s pings while halving steady-state control renewals', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    const socket = new FakeSocket()
    const activatedAt = Date.now()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    for (let interval = 0; interval < 4; interval++) {
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })), false)
    }

    const pings = socket.send.mock.calls.filter((call) =>
      String(call[0]).includes('"ping"')
    )
    expect(pings).toHaveLength(4)
    expect(renewControlActivity).toHaveBeenCalledTimes(2)
    const firstExpiry = Number(renewControlActivity.mock.calls[0]![1].expiresAt)
    const secondExpiry = Number(renewControlActivity.mock.calls[1]![1].expiresAt)
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
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    renewControlActivity.mockRejectedValueOnce(new Error('pool timeout'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const socket = new FakeSocket()
    try {
      await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      expect(renewControlActivity).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      expect(renewControlActivity).toHaveBeenCalledTimes(2)
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
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    const stalled = deferred<void>()
    renewControlActivity.mockReturnValueOnce(stalled.promise)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2)

    expect(renewControlActivity).toHaveBeenCalledTimes(2)
    stalled.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('ignores a superseded renewal resolving after a fresher success', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    const stalled = deferred<void>()
    renewControlActivity.mockReturnValueOnce(stalled.promise)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2)
    expect(renewControlActivity).toHaveBeenCalledTimes(2)
    stalled.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)

    expect(renewControlActivity).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)

    expect(renewControlActivity).toHaveBeenCalledTimes(3)
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('re-acquires a missing control activity lease', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, acquireActivity, renewControlActivity } =
      createRegistry(activateControl)
    renewControlActivity.mockRejectedValueOnce(new Error('control_activity_not_found'))
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)

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
    const { registry, activate, acquireActivity, renewControlActivity } =
      createRegistry(activateControl)
    renewControlActivity.mockRejectedValueOnce(new Error('control_activity_moved'))
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)

    expect(acquireActivity).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.DRAINING, 'control activity moved')
    registry.drain(0)
    vi.advanceTimersByTime(0)
  })

  it('closes when a missing control activity cannot be re-acquired on this cell', async () => {
    const activateControl = vi
      .fn<RelayAssignmentStore['activateControl']>()
      .mockResolvedValue('control:production-gce-c3:1')
    const { registry, activate, acquireActivity, renewControlActivity } =
      createRegistry(activateControl)
    renewControlActivity.mockRejectedValueOnce(new Error('control_activity_not_found'))
    acquireActivity.mockRejectedValueOnce(new Error('activity_cell_not_authoritative'))
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)

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
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    renewControlActivity.mockRejectedValueOnce(new Error('activity_cell_not_authoritative'))
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)

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
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
    registry.drain(60_000)

    for (let interval = 0; interval < 3; interval++) {
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })), false)
    }

    expect(renewControlActivity).toHaveBeenCalledTimes(2)
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
    const { registry, activate, renewControlActivity } = createRegistry(activateControl)
    const ping = RELAY_PROTOCOL_LIMITS.controlPingIntervalMs
    const socket = new FakeSocket()
    await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)

    const beat = async (target: FakeSocket): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ping)
      target.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })), false)
    }

    // Age the session so its attempt counter is well above zero.
    for (let tick = 0; tick < 5; tick++) await beat(socket)
    expect(renewControlActivity).toHaveBeenCalledTimes(3)

    // The next renewal stalls and is still in flight when the control rebinds.
    const stalled = deferred<void>()
    renewControlActivity.mockReturnValueOnce(stalled.promise)
    for (let tick = 0; tick < 2; tick++) await beat(socket)
    expect(renewControlActivity).toHaveBeenCalledTimes(4)

    const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!
    const rebindSocket = new FakeSocket()
    await activate(rebindSocket as unknown as WebSocket, identity, session, 1, true, 1)
    stalled.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)

    const before = renewControlActivity.mock.calls.length
    for (let tick = 0; tick < 4; tick++) await beat(rebindSocket)
    expect(renewControlActivity.mock.calls.length - before).toBe(2)

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
    const { registry, activate, acquireActivity, renewControlActivity } =
      createRegistry(activateControl)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const socket = new FakeSocket()
      await activate(socket as unknown as WebSocket, identity, null, 1, false, 1)
      const session = registry.get({ userId: identity.sub, relayHostId: identity.relayHostId })!

      // The renewal is still in flight when a newer generation takes over.
      let failRenewal!: (error: Error) => void
      renewControlActivity.mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => (failRenewal = reject))
      )
      await vi.advanceTimersByTimeAsync(RELAY_PROTOCOL_LIMITS.controlPingIntervalMs)
      expect(renewControlActivity).toHaveBeenCalledOnce()

      const newer = new FakeSocket()
      await activate(newer as unknown as WebSocket, identity, session, 2, false, 1)

      // Its release already removed the lease, so the renewal reports it missing.
      failRenewal(new Error('control_activity_not_found'))
      await vi.advanceTimersByTimeAsync(0)

      expect(acquireActivity).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      registry.drain(0)
      vi.advanceTimersByTime(0)
    }
  })
})
