import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayAssignmentRowBusyError,
  type RelayAssignment,
  type ResolvedRelayAssignment
} from './assignment-store.js'
import type { RelayConfig } from './config.js'

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
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome)
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
    const app = createRelayApp(config({ drainReturnQueueMax: 1, drainReturnWaitMs: 50 }), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome),
      recordAssignmentRejectionReason: (lane, reason) => reasons.push(`${lane}:${reason}`),
      recordDrainReturnRetryAfter: (seconds) => retryAfters.push(seconds)
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
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /lane=drain-return hinted=true reason=queue-full .*retryAfter=2/
    )
    replacement.resolve(assignment('cell-new', holder))
    expect((await holding).status).toBe(200)
  })

  it('keeps today’s sticky answer when no home is isolated', async () => {
    const host = 'ssssssssssssssss'
    const assign = vi.fn(async () => assignment('cell-s', host))
    const resolve = vi.fn(async () => assignment('cell-s', host))
    const outcomes: string[] = []
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome)
    })

    expect(
      (await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))).status
    ).toBe(200)
    const repeat = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(repeat.status).toBe(503)
    expect(repeat.headers.get('retry-after')).toBe('2')
    expect(outcomes).toEqual(['sticky', 'sticky-rejected'])
  })

  it('never classifies an unhinted request, which keeps the placement lane', async () => {
    const host = 'uuuuuuuuuuuuuuuu'
    const assign = vi.fn(async () => assignment('cell-u', host))
    const resolve = vi.fn(async () => isolatedHome(host))
    const outcomes: string[] = []
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordAssignmentAdmission: (outcome) => outcomes.push(outcome)
    })

    expect((await app.request('/v1/assign', assignmentRequest(host))).status).toBe(200)
    expect(resolve).not.toHaveBeenCalled()
    expect(outcomes).toEqual(['placement'])
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

  it('admits a 2,500-host drain across five directors without a sticky or placement rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Five directors behind a load balancer that sends each request to any of
    // them. 2,500 drained hosts over the 300 s pace window, beside ordinary
    // reconnects (c29 baseline ~13/s) and a trickle of new placements.
    const DIRECTORS = 5
    const DRAINED = 2_500
    const PACE_WINDOW_MS = 300_000
    const ORDINARY = 3_900
    const PLACEMENTS = 30
    // Measured c29 2026-10-01: ~5.8 re-placements/s fleet-wide, bound by the
    // region's inventory lock, so ~172 ms of lock per re-placement.
    const INVENTORY_LOCK_MS = 172
    const ORDINARY_MS = 40
    const drainedHosts = Array.from({ length: DRAINED }, (_, index) => hostId('d', index))
    const moved = new Set<string>()
    const mutex = () => {
      let tail = Promise.resolve()
      return async <T>(run: () => Promise<T>): Promise<T> => {
        const previous = tail
        let release!: () => void
        tail = new Promise((done) => (release = done))
        await previous
        try {
          return await run()
        } finally {
          release()
        }
      }
    }
    const inventoryLock = mutex()
    const outcomes = new Map<string, number>()
    const retryAfters: number[] = []
    const apps = Array.from({ length: DIRECTORS }, () => {
      // serializeAssignment: one placement or re-placement at a time per director.
      const storeMutex = mutex()
      const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
        relayHostId.startsWith('d') && !moved.has(relayHostId)
          ? isolatedHome(relayHostId)
          : assignment('cell-o', relayHostId)
      )
      const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
        if (relayHostId.startsWith('o')) {
          await sleep(ORDINARY_MS)
          return assignment('cell-o', relayHostId)
        }
        return await storeMutex(async () => {
          await inventoryLock(async () => await sleep(INVENTORY_LOCK_MS))
          if (relayHostId.startsWith('d')) moved.add(relayHostId)
          return assignment('cell-new', relayHostId)
        })
      })
      return createRelayApp(config(), {
        store: {} as never,
        assignments: { assign, resolve } as never,
        drain: vi.fn(),
        ready: vi.fn(async () => true),
        recordAssignmentAdmission: (outcome) =>
          outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1),
        recordDrainReturnRetryAfter: (seconds) => retryAfters.push(seconds)
      })
    })
    let seed = 7
    const anyDirector = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return apps[seed % DIRECTORS]!
    }
    const landed = new Set<string>()
    const failures: string[] = []
    let inFlight = 0
    // A desktop client: honour Retry-After on a 503, as the drain retry schedule does.
    const dial = (relayHostId: string, reconnect: boolean): void => {
      inFlight++
      void Promise.resolve(
        anyDirector().request(
          '/v1/assign',
          assignmentRequest(relayHostId, reconnect ? { reconnect } : {})
        )
      ).then((response) => {
        inFlight--
        if (response.status === 200) {
          landed.add(relayHostId)
          return
        }
        const retryAfter = Number(response.headers.get('retry-after'))
        if (response.status !== 503 || !(retryAfter > 0)) {
          failures.push(`${relayHostId}:${response.status}`)
          return
        }
        inFlight++
        setTimeout(() => {
          inFlight--
          dial(relayHostId, reconnect)
        }, retryAfter * 1_000)
      })
    }
    const at = (ms: number, run: () => void): void => {
      inFlight++
      setTimeout(() => {
        inFlight--
        run()
      }, ms)
    }
    drainedHosts.forEach((host, index) =>
      at(Math.floor((index * PACE_WINDOW_MS) / (DRAINED - 1)), () => dial(host, true))
    )
    for (let index = 0; index < ORDINARY; index++) {
      at(Math.floor((index * PACE_WINDOW_MS) / ORDINARY) + 7, () => dial(hostId('o', index), true))
    }
    for (let index = 0; index < PLACEMENTS; index++) {
      at(index * 10_000 + 3, () => dial(hostId('p', index), false))
    }

    let elapsedMs = 0
    while (inFlight > 0 && elapsedMs < 1_200_000) {
      await vi.advanceTimersByTimeAsync(20)
      elapsedMs += 20
      // Signing the lease completes off the timer queue.
      await new Promise((done) => setImmediate(done))
    }

    expect(failures).toEqual([])
    expect(drainedHosts.filter((host) => !landed.has(host))).toEqual([])
    expect(landed.size).toBe(DRAINED + ORDINARY + PLACEMENTS)
    expect(outcomes.get('sticky-rejected') ?? 0).toBe(0)
    expect(outcomes.get('placement-rejected') ?? 0).toBe(0)
    expect(outcomes.get('sticky')).toBe(ORDINARY)
    expect(outcomes.get('placement')).toBe(PLACEMENTS)
    expect(outcomes.get('drain-return')).toBe(DRAINED)
    // Paced returns: fewer than two deferrals per drained host, none past the cap.
    expect(outcomes.get('drain-return-deferred') ?? 0).toBeLessThan(2 * DRAINED)
    expect(Math.max(...retryAfters)).toBeLessThanOrEqual(300)
    // The cohort finishes at the inventory lock's rate, not minutes behind it.
    expect(elapsedMs).toBeLessThan(DRAINED * INVENTORY_LOCK_MS + 60_000)
  }, 300_000)
})

function hostId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(15, '0')}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
