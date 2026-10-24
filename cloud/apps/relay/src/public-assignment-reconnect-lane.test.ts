import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentRowBusyError, type RelayAssignment } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import type { StickySlotSample } from './sticky-slot-statements.js'
import {
  ScriptedPoolClient,
  scriptedPostgresDatabase
} from './test-fixtures/scripted-postgres-pool.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({
    sub: 'user-1',
    relayHostId: token
  }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

describe('public assignment reconnect lane', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('admits a verified reconnect past a saturated placement queue', async () => {
    const reconnecting = 'rrrrrrrrrrrrrrrr'
    const newcomerA = 'aaaaaaaaaaaaaaaa'
    const newcomerB = 'bbbbbbbbbbbbbbbb'
    const blocked = 'cccccccccccccccc'
    const pending = new Map<string, ReturnType<typeof deferred<RelayAssignment>>>()
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      if (relayHostId === reconnecting) return assignment('cell-r', reconnecting)
      const operation = deferred<RelayAssignment>()
      pending.set(relayHostId, operation)
      return await operation.promise
    })
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      relayHostId === reconnecting ? assignment('cell-r', reconnecting) : null
    )
    const outcomes: string[] = []
    const app = createRelayApp(config({ publicAssignmentQueueMax: 0 }), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome)
    })

    // Saturate the placement lane with two in-flight newcomers, zero queue.
    const first = app.request('/v1/assign', assignmentRequest(newcomerA))
    await vi.waitFor(() => expect(pending.has(newcomerA)).toBe(true))
    const second = app.request('/v1/assign', assignmentRequest(newcomerB))
    await vi.waitFor(() => expect(pending.has(newcomerB)).toBe(true))
    expect((await app.request('/v1/assign', assignmentRequest(blocked))).status).toBe(503)

    const reconnected = await app.request(
      '/v1/assign',
      assignmentRequest(reconnecting, { reconnect: true })
    )

    expect(reconnected.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: reconnecting },
      { classifyHomeRollIsolation: true }
    )
    expect(assign).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: reconnecting },
      undefined,
      undefined,
      undefined,
      { hostRequested: true }
    )
    expect(outcomes).toContain('sticky')

    pending.get(newcomerA)?.resolve(assignment('cell-a', newcomerA))
    pending.get(newcomerB)?.resolve(assignment('cell-b', newcomerB))
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
  })

  it('rate-limits repeat fast-lane attempts with the short retry-after', async () => {
    const host = 'rrrrrrrrrrrrrrrr'
    const assign = vi.fn(async () => assignment('cell-r', host))
    const resolve = vi.fn(async () => assignment('cell-r', host))
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    expect(
      (await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))).status
    ).toBe(200)
    const repeat = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(repeat.status).toBe(503)
    expect(repeat.headers.get('retry-after')).toBe('2')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('sends an unverified reconnect hint through the placement lane unchanged', async () => {
    const host = 'nnnnnnnnnnnnnnnn'
    const assign = vi.fn(async () => assignment('cell-n', host))
    const resolve = vi.fn(async () => null)
    const outcomes: string[] = []
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome)
    })

    const response = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(response.status).toBe(200)
    expect(assign).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual(['placement'])
  })

  it('rejects on the fast lane when the verification probe fails transiently', async () => {
    const host = 'tttttttttttttttt'
    const assign = vi.fn()
    const resolve = vi.fn(async () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
    })
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const response = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(assign).not.toHaveBeenCalled()
  })

  it('refuses a dial whose assignment row is busy at once, and frees the fast lane', async () => {
    const busy = 'bbbbbbbbbbbbbbbb'
    const next = 'nnnnnnnnnnnnnnnn'
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      if (relayHostId === busy) throw new RelayAssignmentRowBusyError()
      return assignment('cell-n', next)
    })
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      assignment('cell-r', relayHostId)
    )
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const refused = await app.request('/v1/assign', assignmentRequest(busy, { reconnect: true }))

    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(await refused.json()).toEqual({ error: 'assignment_row_busy' })
    expect(warn.mock.calls.flat().join('\n')).toContain('reason=relay_assignment_row_busy')
    // The single fast-lane slot went back with the refusal.
    expect(
      (await app.request('/v1/assign', assignmentRequest(next, { reconnect: true }))).status
    ).toBe(200)
    warn.mockRestore()
  })

  it('asks a busy resume to retry in a second', async () => {
    const host = 'rrrrrrrrrrrrrrrr'
    const app = createRelayApp(config(), {
      store: {
        resolveResume: vi.fn(async () => ({ userId: 'user-1', relayDeviceId: 'device-1' }))
      } as never,
      assignments: {
        assign: vi.fn(async () => {
          throw new RelayAssignmentRowBusyError()
        }),
        resolve: vi.fn(async () => null)
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await app.request('/v1/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        relayHostId: host,
        resumeToken: Buffer.alloc(32, 1).toString('base64url')
      })
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toEqual({ error: 'relay_assignment_row_busy' })
    warn.mockRestore()
  })

  it('reports what each sticky slot spent its hold on', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const first = 'ffffffffffffffff'
    const queued = 'qqqqqqqqqqqqqqqq'
    const newcomer = 'nnnnnnnnnnnnnnnn'
    const firstHost = new ScriptedPoolClient()
    const queuedHost = new ScriptedPoolClient()
    // first: verify, assign; newcomer: assign; queued: verify, assign.
    const database = scriptedPostgresDatabase([
      firstHost,
      firstHost,
      new ScriptedPoolClient(),
      queuedHost,
      queuedHost
    ])
    const firstAssign = deferred<RelayAssignment>()
    const firstReady = deferred<void>()
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      await database.query('SELECT verify')
      return assignment('cell-r', relayHostId)
    })
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      await database.transaction(async (transaction) => {
        await transaction.query('SELECT pin')
        await transaction.query('UPDATE lease')
      })
      if (relayHostId === first) {
        firstReady.resolve()
        return await firstAssign.promise
      }
      return assignment('cell-r', relayHostId)
    })
    const samples: StickySlotSample[] = []
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordStickySlot: (sample) => samples.push(sample)
    })

    const holding = app.request('/v1/assign', assignmentRequest(first, { reconnect: true }))
    await firstReady.promise
    expect(firstHost.statements).toHaveLength(5)
    const waiting = app.request('/v1/assign', assignmentRequest(queued, { reconnect: true }))
    // A placement request's statements are its own, even while a sticky slot is held.
    expect((await app.request('/v1/assign', assignmentRequest(newcomer))).status).toBe(200)
    await vi.advanceTimersByTimeAsync(60)
    firstAssign.resolve(assignment('cell-r', first))
    expect((await holding).status).toBe(200)
    expect((await waiting).status).toBe(200)

    // Verify, then BEGIN, two statements and COMMIT, each on that host's own connection.
    const roundTrips = (sample: StickySlotSample | undefined) =>
      [...(sample?.statementMsByConnection ?? [])].map(([id, ms]) => [id, ms.length])
    expect(samples).toHaveLength(2)
    expect(samples[0]).toMatchObject({ statements: 5 })
    expect(roundTrips(samples[0])).toEqual([[1, 5]])
    expect(samples[0]?.queueWaitMs).toBe(0)
    expect(samples[1]).toMatchObject({ statements: 5 })
    expect(roundTrips(samples[1])).toEqual([[3, 5]])
    expect(samples[1]?.queueWaitMs).toBe(60)
  })
})

function assignmentRequest(relayHostId: string, extra: { reconnect?: boolean } = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayHostId}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, relayHostId, ...extra })
  }
}

function assignment(cellId: string, relayHostId: string): RelayAssignment {
  return {
    userId: 'user-1',
    relayHostId,
    cellId,
    cellUrl: `https://${cellId}.relay.example.test`,
    assignmentEpoch: 1,
    leaseExpiresAt: Date.now() + 300_000
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
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
