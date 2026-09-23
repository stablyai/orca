import { describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import {
  createRelayReadiness,
  RELAY_READINESS_JWKS_GRACE_MS,
  RELAY_READINESS_SQL_GRACE_MS,
  type RelayReadinessGraceEvent,
  type RelayReadinessObservation
} from './relay-readiness.js'

function database(query: () => Promise<Record<string, unknown>[]>): RelayDatabase {
  return {
    query,
    queryLocked: query,
    transaction: async (operation) => await operation(database(query)),
    close: async () => {}
  }
}

describe('relay readiness', () => {
  it.each([200, 503])('releases every unused JWKS response body for status %i', async (status) => {
    let activeBodies = 0
    const readiness = createRelayReadiness(database(async () => [{ ready: 1 }]), 'https://jwks', {
      fetch: async () => {
        activeBodies++
        return new Response(
          new ReadableStream({
            cancel() {
              activeBodies--
            }
          }),
          { status }
        )
      },
      cacheMs: 0
    })

    for (let attempt = 0; attempt < 20; attempt++) {
      expect(await readiness.check()).toBe(status === 200)
      expect(activeBodies).toBe(0)
    }
  })

  it('fails readiness while liveness remains independent of SQL and JWKS', async () => {
    const jwksFailure = createRelayReadiness(database(async () => [{ ready: 1 }]), 'https://jwks', {
      fetch: vi.fn(async () => new Response('', { status: 503 })) as typeof fetch,
      cacheMs: 0
    })
    const sqlFailure = createRelayReadiness(
      database(async () => {
        throw new Error('sql down')
      }),
      'https://jwks',
      {
        fetch: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
        cacheMs: 0
      }
    )

    expect(await jwksFailure.check()).toBe(false)
    expect(await sqlFailure.check()).toBe(false)
  })

  it.each([
    {
      name: 'JWKS HTTP failure',
      fetch: vi.fn(async () => new Response('', { status: 503 })) as typeof fetch,
      query: vi.fn(async () => [{ ready: 1 }]),
      failure: 'jwks_http_failed'
    },
    {
      name: 'JWKS timeout',
      fetch: vi.fn(async () => {
        throw new DOMException('redacted', 'TimeoutError')
      }) as typeof fetch,
      query: vi.fn(async () => [{ ready: 1 }]),
      failure: 'jwks_timed_out'
    },
    {
      name: 'JWKS fetch failure',
      fetch: vi.fn(async () => {
        throw new Error('redacted')
      }) as typeof fetch,
      query: vi.fn(async () => [{ ready: 1 }]),
      failure: 'jwks_fetch_failed'
    },
    {
      name: 'SQL failure',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      query: vi.fn(async () => {
        throw new Error('redacted')
      }),
      failure: 'sql_failed'
    }
  ])('reports a safe reason for $name', async ({ fetch, query, failure }) => {
    const observations: RelayReadinessObservation[] = []
    const readiness = createRelayReadiness(database(query), 'https://jwks', {
      fetch,
      cacheMs: 0,
      observe: (observation) => observations.push(observation)
    })

    expect(await readiness.check()).toBe(false)
    expect(observations).toEqual([expect.objectContaining({ ready: false, failure })])
    expect(JSON.stringify(observations)).not.toContain('redacted')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('reports the initial success but not healthy repeats or cached reads', async () => {
    const observations: RelayReadinessObservation[] = []
    let now = 100
    const readiness = createRelayReadiness(database(async () => [{ ready: 1 }]), 'https://jwks', {
      fetch: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      cacheMs: 10_000,
      now: () => now,
      observe: (observation) => observations.push(observation)
    })

    expect(await readiness.check()).toBe(true)
    now += 1_000
    expect(await readiness.check()).toBe(true)
    now += 10_000
    expect(await readiness.check()).toBe(true)
    expect(observations).toEqual([
      {
        ready: true,
        jwksLatencyMs: 0,
        sqlLatencyMs: 0,
        totalLatencyMs: 0
      }
    ])
  })
})

describe('relay readiness last-known-good grace', () => {
  function graceProbe(input: {
    jwksGraceMs?: number
    sqlGraceMs?: number
    cacheMs?: number
    jwksOk: () => boolean
    sqlOk: () => boolean
    now: () => number
  }) {
    const observations: RelayReadinessObservation[] = []
    const graceEvents: RelayReadinessGraceEvent[] = []
    const query = vi.fn(async () => {
      if (!input.sqlOk()) throw new Error('redacted')
      return [{ ready: 1 }]
    })
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: input.jwksOk() ? 200 : 503 })
    ) as typeof fetch
    const readiness = createRelayReadiness(database(query), 'https://jwks', {
      fetch: fetchImpl,
      cacheMs: input.cacheMs ?? 0,
      ...(input.jwksGraceMs === undefined ? {} : { jwksGraceMs: input.jwksGraceMs }),
      ...(input.sqlGraceMs === undefined ? {} : { sqlGraceMs: input.sqlGraceMs }),
      now: input.now,
      observe: (observation) => observations.push(observation),
      observeGrace: (event) => graceEvents.push(event)
    })
    return { readiness, observations, graceEvents, query, fetchImpl }
  }

  it('stays ready while a JWKS failure sits inside the default fifteen minute window', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness, observations } = graceProbe({
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += RELAY_READINESS_JWKS_GRACE_MS - 1
    expect(await readiness.check()).toBe(true)
    expect(readiness.degradedDependencies()).toEqual(['jwks'])
    expect(observations.at(-1)).toEqual(
      expect.objectContaining({
        ready: true,
        degraded: true,
        degradedDependencies: ['jwks'],
        failure: 'jwks_http_failed'
      })
    )
  })

  it('drops readiness once the JWKS window expires', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness, observations } = graceProbe({
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += RELAY_READINESS_JWKS_GRACE_MS
    expect(await readiness.check()).toBe(false)
    expect(readiness.degradedDependencies()).toEqual([])
    expect(observations.at(-1)).toEqual(
      expect.objectContaining({ ready: false, failure: 'jwks_http_failed' })
    )
    expect(observations.at(-1)).not.toHaveProperty('degraded')
  })

  it('gives SQL a shorter window than JWKS by default', async () => {
    let now = 1_000
    let sqlOk = true
    const { readiness, observations } = graceProbe({
      jwksOk: () => true,
      sqlOk: () => sqlOk,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    sqlOk = false
    now += RELAY_READINESS_SQL_GRACE_MS - 1
    expect(await readiness.check()).toBe(true)
    expect(observations.at(-1)).toEqual(
      expect.objectContaining({
        ready: true,
        degraded: true,
        degradedDependencies: ['sql'],
        failure: 'sql_failed'
      })
    )
    now += 1
    expect(await readiness.check()).toBe(false)
    expect(RELAY_READINESS_SQL_GRACE_MS).toBeLessThan(RELAY_READINESS_JWKS_GRACE_MS)
  })

  it('keeps a process that never succeeded out of the grace window', async () => {
    let now = 1_000
    const { readiness, observations, graceEvents } = graceProbe({
      jwksOk: () => false,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(false)
    now += 1_000
    expect(await readiness.check()).toBe(false)
    expect(graceEvents).toEqual([])
    expect(observations.every((observation) => observation.degraded === undefined)).toBe(true)
  })

  it('measures the grace window on the injected clock, not wall time', async () => {
    const now = 1_000
    let jwksOk = true
    const { readiness } = graceProbe({ jwksOk: () => jwksOk, sqlOk: () => true, now: () => now })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    for (let attempt = 0; attempt < 5; attempt++) expect(await readiness.check()).toBe(true)
  })

  it('logs once on entering grace and once on leaving it', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness, graceEvents } = graceProbe({
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 1_000
    expect(await readiness.check()).toBe(true)
    now += 1_000
    expect(await readiness.check()).toBe(true)
    jwksOk = true
    now += 1_000
    expect(await readiness.check()).toBe(true)
    expect(graceEvents).toEqual([
      {
        dependency: 'jwks',
        grace: 'entered',
        failure: 'jwks_http_failed',
        lastSuccessAgeMs: 1_000,
        graceMs: RELAY_READINESS_JWKS_GRACE_MS
      },
      {
        dependency: 'jwks',
        grace: 'recovered',
        lastSuccessAgeMs: 0,
        graceMs: RELAY_READINESS_JWKS_GRACE_MS
      }
    ])
  })

  it('reports an expired window once when the dependency never comes back', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness, graceEvents } = graceProbe({
      jwksGraceMs: 10_000,
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 1_000
    expect(await readiness.check()).toBe(true)
    now += 20_000
    expect(await readiness.check()).toBe(false)
    expect(await readiness.check()).toBe(false)
    expect(graceEvents.map((event) => event.grace)).toEqual(['entered', 'expired'])
  })

  it('restarts the grace window from the most recent success', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness } = graceProbe({
      jwksGraceMs: 10_000,
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 9_000
    expect(await readiness.check()).toBe(true)
    jwksOk = true
    now += 1_000
    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 9_000
    expect(await readiness.check()).toBe(true)
  })

  it('never serves grace when the window is disabled', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness, graceEvents } = graceProbe({
      jwksGraceMs: 0,
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    expect(await readiness.check()).toBe(false)
    expect(graceEvents).toEqual([])
  })

  it('keeps one clock per dependency so a healthy JWKS cannot hold SQL open', async () => {
    let now = 1_000
    let sqlOk = true
    const { readiness, graceEvents } = graceProbe({
      sqlGraceMs: 10_000,
      jwksOk: () => true,
      sqlOk: () => sqlOk,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    sqlOk = false
    for (let elapsed = 1_000; elapsed <= 11_000; elapsed += 1_000) {
      now = 1_000 + elapsed
      await readiness.check()
    }
    expect(await readiness.check()).toBe(false)
    expect(graceEvents.map((event) => [event.dependency, event.grace])).toEqual([
      ['sql', 'entered'],
      ['sql', 'expired']
    ])
  })

  it('logs both sides of an overlap when one dependency recovers as the other fails', async () => {
    let now = 1_000
    let jwksOk = true
    let sqlOk = true
    const { readiness, graceEvents } = graceProbe({
      jwksOk: () => jwksOk,
      sqlOk: () => sqlOk,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 1_000
    expect(await readiness.check()).toBe(true)
    jwksOk = true
    sqlOk = false
    now += 1_000
    expect(await readiness.check()).toBe(true)
    expect(readiness.degradedDependencies()).toEqual(['sql'])
    expect(graceEvents.map((event) => [event.dependency, event.grace])).toEqual([
      ['jwks', 'entered'],
      ['jwks', 'recovered'],
      ['sql', 'entered']
    ])
  })

  it('probes SQL on every poll even while JWKS is failing', async () => {
    let now = 1_000
    let jwksOk = true
    let sqlOk = true
    const { readiness, observations, query } = graceProbe({
      sqlGraceMs: 10_000,
      jwksOk: () => jwksOk,
      sqlOk: () => sqlOk,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 1_000
    expect(await readiness.check()).toBe(true)
    sqlOk = false
    now += 1_000
    expect(await readiness.check()).toBe(true)
    expect(observations.at(-1)).toEqual(
      expect.objectContaining({
        ready: true,
        failure: 'jwks_http_failed',
        failures: ['jwks_http_failed', 'sql_failed'],
        degradedDependencies: ['jwks', 'sql']
      })
    )
    // The SQL clock runs on evidence, so its window opens at the poll that saw SQL fail.
    now += 10_000
    expect(await readiness.check()).toBe(false)
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('serves a stale ready answer for at most the cache window after grace expires', async () => {
    let now = 1_000
    let jwksOk = true
    const { readiness, fetchImpl } = graceProbe({
      cacheMs: 10_000,
      jwksGraceMs: 5_000,
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 6_000
    expect(await readiness.check()).toBe(true)
    now += 3_999
    expect(await readiness.check()).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += 1
    expect(await readiness.check()).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
