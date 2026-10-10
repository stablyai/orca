import { EventEmitter } from 'node:events'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { z } from 'zod'
import type { RelayAssignmentStore } from './assignment-store.js'
import { CELL_FLAG_DEFAULTS, type CellFlags } from './cell-flags.js'
import type { RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { HostSessionRegistry, type HostSession } from './host-session-registry.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

const adminTokenChecks = vi.hoisted(() => ({ count: 0 }))

vi.mock('./admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string) => {
    adminTokenChecks.count += 1
    return token === 'deploy-token'
  },
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async () => false,
  createRegionalRehomeRuntimeTokenVerifier: () => async () => false,
  createRegionalRehomeTokenVerifier: () => async (token: string) => token === 'rehome-token',
  createRuntimeTokenVerifier: () => async () => false
}))

import { createRelayApp } from './app.js'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason ?? ''))
  })
}

const incarnation = '11111111-1111-4111-8111-111111111111'

// The published v1 shape, so a field rename fails here before it reaches a director.
const SeatChangeSchema = z.object({
  seq: z.number(),
  kind: z.enum(['join', 'leave', 'drain-only', 'active']),
  userId: z.string(),
  relayHostId: z.string(),
  epoch: z.number(),
  generation: z.number(),
  state: z.enum(['active', 'drain-only']).optional(),
  closeCode: z.number().optional(),
  at: z.number()
})
const SeatFeedReplySchema = z.object({
  v: z.literal(1),
  cellId: z.string(),
  incarnation: z.string(),
  at: z.number(),
  draining: z.boolean(),
  counts: z.object({
    controls: z.number(),
    seats: z.number()
  }),
  flagsApplied: z
    .object({
      generation: z.number(),
      flags: z.object({
        readinessLocal: z.boolean(),
        ticketCheck: z.enum(['off', 'shadow', 'enforce']),
        rejectionFence: z.boolean(),
        admitMode: z.enum(['db', 'reserve']),
        reserveDryRun: z.boolean()
      }),
      ignoredKeys: z.array(z.string()).optional()
    })
    .optional(),
  seq: z.number(),
  changes: z.array(SeatChangeSchema).optional(),
  more: z.boolean().optional(),
  full: z
    .array(
      z.object({
        userId: z.string(),
        relayHostId: z.string(),
        epoch: z.number(),
        generation: z.number(),
        state: z.enum(['active', 'drain-only']),
        joinedAt: z.number()
      })
    )
    .optional()
})

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://c7.relay.example.test',
    cellUrl: 'https://c7.relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c7',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    rehomeDirectorServiceAccount: 'relay-director@example.test',
    rehomeAudience: 'https://relay.example.test/v1/admin/host-drain',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data',
    ...overrides
  }
}

function hostIdentity(index: number, exp = 4_102_444_800): RelayTokenClaims {
  return {
    sub: `user-${index}`,
    prof: 'profile-1',
    relayHostId: `host${String(index).padStart(12, '0')}`,
    purpose: 'host-control',
    exp
  }
}

// What a host's auth-refresh token verifies as.
const verifyRelayToken = vi.fn<(token: string) => Promise<RelayTokenClaims | null>>()

function createCell(relayConfig = config(), cellFlags?: () => AppliedControlFlags<CellFlags>) {
  const assignments = {
    activateControl: vi.fn().mockResolvedValue('control:production-gce-c7:1'),
    markMigrationTargetRegistered: vi.fn().mockResolvedValue(undefined),
    releaseActivity: vi.fn().mockResolvedValue(true),
    renewControlActivities: vi.fn().mockResolvedValue([])
  } as unknown as RelayAssignmentStore
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn()
  } satisfies RelayRuntimeObserver
  const registry = new HostSessionRegistry(
    relayConfig,
    verifyRelayToken,
    {} as RelayCredentialStore,
    assignments,
    new ProcessQueuedByteBudget(),
    observer,
    Date.now,
    Math.random,
    incarnation
  )
  const activate = (
    registry as unknown as {
      activate: (
        socket: WebSocket,
        identity: RelayTokenClaims,
        existing: HostSession | null,
        generation: number,
        rebind: boolean,
        assignmentEpoch: number,
        appVersion: string
      ) => Promise<void>
    }
  ).activate.bind(registry)
  const connect = async (
    index: number,
    options: { generation?: number; epoch?: number; rebind?: boolean; exp?: number } = {}
  ): Promise<FakeSocket> => {
    const socket = new FakeSocket()
    const identity = hostIdentity(index, options.exp)
    await activate(
      socket as unknown as WebSocket,
      identity,
      registry.get({ userId: identity.sub, relayHostId: identity.relayHostId }),
      options.generation ?? 1,
      options.rebind ?? false,
      options.epoch ?? 1,
      '1.4.200'
    )
    return socket
  }
  const app = createRelayApp(relayConfig, {
    store: {} as never,
    assignments: {} as never,
    drain: (graceMs, options) => registry.drain(graceMs, options ?? {}),
    cellIncarnation: incarnation,
    cellSeatFeed: (sinceSeq) => registry.seatFeed(sinceSeq),
    cellFlags,
    isDraining: () => registry.isDraining(),
    runtimeCounts: () => ({
      totalConnections: 0,
      preAuthConnections: 0,
      queuedBytes: 0,
      ...registry.runtimeCounts()
    }),
    ready: vi.fn(async () => true)
  })
  const poll = async (since?: string, token = 'rehome-token') =>
    await app.request(
      `/v1/admin/cell-seats${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`,
      { headers: { authorization: `Bearer ${token}` } }
    )
  const read = async (since?: string) => SeatFeedReplySchema.parse(await (await poll(since)).json())
  return { registry, connect, app, poll, read }
}

describe('cell seat feed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('answers a first poll with every seated host, matching the controls count', async () => {
    const { connect, poll, read } = createCell()
    await connect(1)
    await connect(2, { epoch: 4 })
    expect((await poll()).status).toBe(200)
    const body = await read()
    expect(body).toMatchObject({
      v: 1,
      cellId: 'production-gce-c7',
      incarnation,
      seq: 2,
      draining: false,
      counts: { controls: 2, seats: 2 }
    })
    expect(body.full).toHaveLength(body.counts.seats)
    expect(body.full).toContainEqual(
      expect.objectContaining({ userId: 'user-2', epoch: 4, generation: 1, state: 'active' })
    )
  })

  it('keeps a closing socket seated until its close lands, as the change log does', async () => {
    const { connect, read } = createCell()
    const socket = await connect(1)
    // The ws close handshake: no longer OPEN, close event not yet emitted.
    socket.readyState = 2
    const closing = await read()
    expect(closing.counts).toMatchObject({ controls: 0, seats: 1 })
    expect(closing.full).toHaveLength(1)
    socket.readyState = socket.CLOSED
    socket.emit('close', 1000, Buffer.from(''))
    expect((await read()).counts).toMatchObject({ controls: 0, seats: 0 })
  })

  it('reports join, drain-only and leave as changes after the cursor', async () => {
    const { registry, connect, read } = createCell()
    const socket = await connect(1)
    const { seq } = await read()
    registry.drain(60_000)
    socket.close(RELAY_CLOSE_CODE.DRAINING, 'relay draining')
    await connect(2)
    const body = await read(`${incarnation}:${seq}`)
    expect(body.full).toBeUndefined()
    expect(body.draining).toBe(true)
    expect(body.changes?.map((change) => change.kind)).toEqual([
      'drain-only',
      'leave'
    ])
    expect(body.changes?.[1]).toMatchObject({
      userId: 'user-1',
      closeCode: RELAY_CLOSE_CODE.DRAINING,
      generation: 1
    })
    // The second connect landed after the drain, so the cell refused it: no join.
    expect(body.seq).toBe(seq + 2)
  })

  it('reports an auth expiry as drain-only and the refresh that clears it as active', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { connect, read } = createCell()
    const exp = Math.floor(Date.now() / 1000) + 5
    const socket = await connect(1, { exp })
    const { seq } = await read()
    // The 15 s heartbeat finds the token expired, inside its grace.
    await vi.advanceTimersByTimeAsync(15_000)
    verifyRelayToken.mockResolvedValueOnce(hostIdentity(1, exp + 3_600))
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'auth-refresh', relayJwt: 'refreshed' })),
      false
    )
    await vi.waitFor(() => expect(verifyRelayToken).toHaveBeenCalled())
    const body = await read(`${incarnation}:${seq}`)
    expect(body.changes?.map((change) => change.kind)).toEqual(['drain-only', 'active'])
    expect(body.counts.seats).toBe(1)
    expect((await read()).full).toEqual([expect.objectContaining({ state: 'active' })])
  })

  it('does not report a rebind as a leave, and joins the rebound socket', async () => {
    const { connect, read } = createCell()
    await connect(1)
    const { seq } = await read()
    await connect(1, { rebind: true, epoch: 2 })
    const body = await read(`${incarnation}:${seq}`)
    expect(body.changes).toEqual([
      expect.objectContaining({ kind: 'join', userId: 'user-1', epoch: 2, state: 'active' })
    ])
  })

  it('reports a superseded generation leaving after its successor joined', async () => {
    const { connect, read } = createCell()
    await connect(1)
    const { seq } = await read()
    await connect(1, { generation: 2 })
    const body = await read(`${incarnation}:${seq}`)
    // Readers drop the leave: its generation is older than the seat's.
    expect(
      body.changes?.map((change) => [change.kind, change.generation])
    ).toEqual([
      ['leave', 1],
      ['join', 2]
    ])
  })

  it('resyncs a cursor from another incarnation with a full snapshot', async () => {
    const { connect, poll, read } = createCell()
    await connect(1)
    const body = await read('22222222-2222-4222-8222-222222222222:1')
    expect(body.full).toHaveLength(1)
    expect((await poll('not a cursor')).status).toBe(400)
  })

  it('reports the applied cell flags, so a flip can be read back through the feed and runtime status', async () => {
    let applied: AppliedControlFlags<CellFlags> = { generation: 0, flags: CELL_FLAG_DEFAULTS }
    const { read, app } = createCell(config(), () => applied)
    expect((await read()).flagsApplied).toEqual({ generation: 0, flags: CELL_FLAG_DEFAULTS })
    applied = { generation: 12, flags: { ...CELL_FLAG_DEFAULTS, readinessLocal: true, ticketCheck: 'shadow' } }
    expect((await read()).flagsApplied).toEqual(applied)
    const runtime = await app.request('/v1/admin/runtime-status', {
      method: 'POST',
      headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 })
    })
    expect(await runtime.json()).toMatchObject({
      flagsApplied: applied,
      databasePoolMax: expect.any(Number),
      // What the flag tool checks a write against before it writes.
      supportedFlags: {
        readinessLocal: { type: 'boolean' },
        ticketCheck: { type: 'enum', values: ['off', 'shadow'] },
        rejectionFence: { type: 'boolean' },
        readTimeoutMarginMs: { type: 'number', min: 1_000, max: 60_000, integer: true },
        admitMode: { type: 'enum', values: ['db', 'reserve'] },
        intakePerSec: { type: 'number', max: 1_000 },
        reserveDryRun: { type: 'boolean' },
        reregisterInFlight: { type: 'number', min: 1, max: 16, integer: true }
      }
    })
  })

  it('accepts only the directors rehome identity, verified once per poll', async () => {
    const { poll } = createCell()
    adminTokenChecks.count = 0
    expect((await poll(undefined, 'deploy-token')).status).toBe(401)
    expect((await poll(undefined, 'wrong')).status).toBe(401)
    expect((await poll()).status).toBe(200)
    // The admin middleware leaves this route to its own rehome check.
    expect(adminTokenChecks.count).toBe(0)
  })

  it('is unavailable on a cell without the rehome pair, and on directors', async () => {
    const withoutPair = createCell(
      config({ rehomeAudience: undefined, rehomeDirectorServiceAccount: undefined })
    )
    const response = await withoutPair.poll()
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'seat_feed_unavailable' })
    const director = createCell(config({ role: 'director', cellId: 'director' }))
    expect((await director.poll()).status).toBe(404)
  })

  // Review B1: the feed must not need the pair on more cells, and must not change what a cell
  // with or without it reports as its rehome protocol.
  it('leaves the reported rehome protocol to the existing env', async () => {
    const rehomeProtocol = async (relayConfig: RelayConfig) => {
      const response = await createCell(relayConfig).app.request('/v1/admin/runtime-status', {
        method: 'POST',
        headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1 })
      })
      return z.object({ regionalRehomeProtocol: z.number() }).parse(await response.json())
        .regionalRehomeProtocol
    }
    expect(await rehomeProtocol(config())).toBe(3)
    expect(
      await rehomeProtocol(
        config({ rehomeAudience: undefined, rehomeDirectorServiceAccount: undefined })
      )
    ).toBe(0)
  })
})
