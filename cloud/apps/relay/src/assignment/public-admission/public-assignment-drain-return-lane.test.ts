import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayAssignmentRowBusyError,
  type RelayAssignment,
  type ResolvedRelayAssignment
} from '../assignment-store.js'
import type { RelayConfig } from '../../config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({
    sub: 'user-1',
    relayHostId: token
  }))
}))

vi.mock('../../authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from '../../app.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('drain-return lane', () => {
  it('sends a host whose home is roll-isolated past a busy sticky lane', async () => {
    const drained = 'dddddddddddddddd'
    const ordinary = 'oooooooooooooooo'
    const replacement = deferred<RelayAssignment>()
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      relayHostId === drained ? await replacement.promise : assignment('cell-o', relayHostId)
    )
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      relayHostId === drained ? isolatedHome(relayHostId) : assignment('cell-o', relayHostId)
    )
    const outcomes: string[] = []
    const servedLanes: string[] = []
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome),
      recordAdmissionServiceMs: (lane) => servedLanes.push(lane)
    })

    // The re-placement holds the drain lane; the sticky lane's only slot is free.
    const moving = app.request('/v1/assign', assignmentRequest(drained, { reconnect: true }))
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    const reconnect = await app.request(
      '/v1/assign',
      assignmentRequest(ordinary, { reconnect: true })
    )

    expect(reconnect.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: drained },
      { classifyHomeRollIsolation: true }
    )
    replacement.resolve(assignment('cell-new', drained))
    expect((await moving).status).toBe(200)
    expect(outcomes).toEqual(['drain-return', 'sticky'])
    // The drained host held a sticky slot for its verification read too.
    expect(servedLanes).toEqual(['sticky', 'sticky', 'drain-return'])
  })

  it('defers an overflowing drain return with a paced Retry-After and says why', async () => {
    const holder = 'hhhhhhhhhhhhhhhh'
    const replacement = deferred<RelayAssignment>()
    const assign = vi.fn(async () => await replacement.promise)
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      isolatedHome(relayHostId)
    )
    const outcomes: string[] = []
    const reasons: string[] = []
    const retryAfters: number[] = []
    const causes: string[] = []
    const app = createRelayApp(config({ drainReturnQueueMax: 1, drainReturnWaitMs: 50 }), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome),
      recordAssignmentRejectionReason: (lane, reason) => reasons.push(`${lane}:${reason}`),
      recordDrainReturnRetryAfter: (seconds) => retryAfters.push(seconds),
      recordAssignmentUnavailable: (cause) => causes.push(cause)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const holding = app.request('/v1/assign', assignmentRequest(holder, { reconnect: true }))
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    const queued = app.request(
      '/v1/assign',
      assignmentRequest('qqqqqqqqqqqqqqqq', { reconnect: true })
    )
    const overflow = await app.request(
      '/v1/assign',
      assignmentRequest('ffffffffffffffff', { reconnect: true })
    )

    expect(overflow.status).toBe(503)
    expect(overflow.headers.get('retry-after')).toBe('2')
    const timedOut = await queued
    expect(timedOut.status).toBe(503)
    expect(Number(timedOut.headers.get('retry-after'))).toBeGreaterThanOrEqual(2)
    expect(reasons).toEqual(['drain-return:queue-full', 'drain-return:wait-timeout'])
    expect(retryAfters).toEqual([2, Number(timedOut.headers.get('retry-after'))])
    expect(outcomes.filter((outcome) => outcome === 'drain-return-deferred')).toHaveLength(2)
    expect(causes).toEqual(['drain-return-deferred', 'drain-return-deferred'])
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /lane=drain-return hinted=true reason=queue-full .*retryAfter=2/
    )
    replacement.resolve(assignment('cell-new', holder))
    expect((await holding).status).toBe(200)
  })

  it('answers a drained host’s row-busy redial with the short interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const holder = 'hhhhhhhhhhhhhhhh'
    const host = 'bbbbbbbbbbbbbbbb'
    const holding = deferred<RelayAssignment>()
    let busy = true
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      if (relayHostId === holder) return await holding.promise
      if (relayHostId === host && busy) {
        busy = false
        throw new RelayAssignmentRowBusyError()
      }
      return assignment('cell-new', relayHostId)
    })
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      isolatedHome(relayHostId)
    )
    const app = createRelayApp(config({ drainReturnQueueMax: 1 }), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const request = (relayHostId: string) =>
      Promise.resolve(
        app.request('/v1/assign', assignmentRequest(relayHostId, { reconnect: true }))
      )

    const held = request(holder)
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    const queued = request(host)
    await vi.advanceTimersByTimeAsync(10)
    // A cohort behind it books the next ten service slots.
    for (let index = 0; index < 10; index++) {
      const overflow = await request(hostId('f', index))
      expect(overflow.status).toBe(503)
    }
    await vi.advanceTimersByTimeAsync(2_490)
    holding.resolve(assignment('cell-new', holder))
    expect((await held).status).toBe(200)
    const refused = await queued
    expect(refused.headers.get('retry-after')).toBe('1')

    await vi.advanceTimersByTimeAsync(1_000)
    const redial = await request(host)

    // Its own lane interval, not a slot after the ten hosts that came later.
    expect(redial.status).toBe(503)
    expect(redial.headers.get('retry-after')).toBe('2')
  })

})

function hostId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(15, '0')}`
}

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

function isolatedHome(relayHostId: string): ResolvedRelayAssignment {
  return { ...assignment('cell-isolated', relayHostId), homeCellRollIsolated: true }
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
