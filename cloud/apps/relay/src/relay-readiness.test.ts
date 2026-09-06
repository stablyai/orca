import { describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import {
  createRelayReadiness,
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

    expect(await jwksFailure()).toBe(false)
    expect(await sqlFailure()).toBe(false)
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
    const ready = createRelayReadiness(database(query), 'https://jwks', {
      fetch,
      cacheMs: 0,
      observe: (observation) => observations.push(observation)
    })

    expect(await ready()).toBe(false)
    expect(observations).toEqual([
      expect.objectContaining({ ready: false, failure })
    ])
    expect(JSON.stringify(observations)).not.toContain('redacted')
    if (failure.startsWith('jwks_')) expect(query).not.toHaveBeenCalled()
  })

  it('reports the initial success but not healthy repeats or cached reads', async () => {
    const observations: RelayReadinessObservation[] = []
    let now = 100
    const ready = createRelayReadiness(database(async () => [{ ready: 1 }]), 'https://jwks', {
      fetch: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      cacheMs: 10_000,
      now: () => now,
      observe: (observation) => observations.push(observation)
    })

    expect(await ready()).toBe(true)
    now += 1_000
    expect(await ready()).toBe(true)
    now += 10_000
    expect(await ready()).toBe(true)
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
