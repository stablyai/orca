import { EventEmitter } from 'node:events'
import { CONTROL_CONTINUITY_LIMITS } from '@orca-cloud/relay-contract/control-continuity'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract/close-codes'
import { RELAY_HOST_CAPABILITY_IDLE_REGIONAL_REHOME } from '@orca-cloud/relay-contract/control-messages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from '../assignment/assignment-store.js'
import type { RelayConfig } from '../config.js'
import type { RelayCredentialStore } from '../credentials/credential-store.js'
import { CONTROL_RENEWAL_BATCH_INTERVAL_MS } from '../control-leases/control-renewal-batch.js'
import type {
  ControlRenewalOutcome
} from '../control-leases/control-renewal-statement.js'
import {
  HostSessionRegistry,
  IDLE_REHOME_MIN_CONTROL_AGE_MS,
  type HostSession
} from './host-session-registry.js'
import type { RelayRuntimeObserver } from '../observability/relay-observability.js'
import type { RelayTokenClaims } from '../authentication/relay-token-verifier.js'
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

  // c34 ghost seat came from activation outliving orphan grace and reviving a removed session outside the map.
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
    // The grace runs out while the database answers slowly.
    await vi.advanceTimersByTimeAsync(CONTROL_CONTINUITY_LIMITS.orphanGraceMs)
    expect(registry.get(key)).toBeNull()
    blocked.resolve('control:production-gce-c3:1')
    await rebinding

    expect(rebindSocket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.PEER_DROPPED,
      'control activation superseded'
    )
    expect(registry.get(key)).toBeNull()
    expect(original?.state).toBe('closed')
    const page = registry.seatFeed(null)
    expect('full' in page && page.full).toEqual([])
    expect(releaseActivity).toHaveBeenCalledWith(key, 'control:production-gce-c3:1')
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
  async function source() {
    const h = createRegistry(vi.fn().mockResolvedValue('control:1'))
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
    vi.setSystemTime(Date.now() + IDLE_REHOME_MIN_CONTROL_AGE_MS)
    return { ...h, socket, session: h.registry.get(request)! }
  }

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
})
