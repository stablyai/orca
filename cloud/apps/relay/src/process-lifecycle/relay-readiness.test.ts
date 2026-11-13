import { describe, expect, it } from 'vitest'
import type { RelayDatabase } from '../database/database.js'
import { createRelayReadiness } from './relay-readiness.js'

function database(query: () => Promise<Record<string, unknown>[]>): RelayDatabase {
  return {
    query,
    queryLocked: query,
    transaction: async (operation) => await operation(database(query)),
    close: async () => {}
  }
}

describe('relay readiness last-known-good grace', () => {
  function graceProbe(input: {
    jwksGraceMs?: number
    sqlGraceMs?: number
    jwksOk: () => boolean
    sqlOk: () => boolean
    now: () => number
  }) {
    const query = async () => {
      if (!input.sqlOk()) throw new Error('redacted')
      return [{ ready: 1 }]
    }
    const fetchImpl: typeof fetch = async () =>
      new Response('{}', { status: input.jwksOk() ? 200 : 503 })
    const readiness = createRelayReadiness(database(query), 'https://jwks', {
      fetch: fetchImpl,
      cacheMs: 0,
      ...(input.jwksGraceMs === undefined ? {} : { jwksGraceMs: input.jwksGraceMs }),
      ...(input.sqlGraceMs === undefined ? {} : { sqlGraceMs: input.sqlGraceMs }),
      now: input.now
    })
    return readiness
  }

  it('drops readiness once the configured JWKS window expires', async () => {
    let now = 1_000
    let jwksOk = true
    const readiness = graceProbe({
      jwksGraceMs: 10_000,
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    now += 10_000
    expect(await readiness.check()).toBe(false)
    expect(readiness.degradedDependencies()).toEqual([])
  })

  it('keeps a process that never succeeded out of the grace window', async () => {
    let now = 1_000
    const readiness = graceProbe({
      jwksOk: () => false,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(false)
    now += 1_000
    expect(await readiness.check()).toBe(false)
  })

  it('restarts the grace window from the most recent success', async () => {
    let now = 1_000
    let jwksOk = true
    const readiness = graceProbe({
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
    const readiness = graceProbe({
      jwksGraceMs: 0,
      jwksOk: () => jwksOk,
      sqlOk: () => true,
      now: () => now
    })

    expect(await readiness.check()).toBe(true)
    jwksOk = false
    expect(await readiness.check()).toBe(false)
  })

  it('expires SQL grace despite continuing JWKS failures', async () => {
    let now = 1_000
    let jwksOk = true
    let sqlOk = true
    const readiness = graceProbe({
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
    // The SQL clock runs on evidence, so its window opens at the poll that saw SQL fail.
    now += 10_000
    expect(await readiness.check()).toBe(false)
  })

})
