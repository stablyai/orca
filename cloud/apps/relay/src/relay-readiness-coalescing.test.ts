import { expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import { createRelayReadiness } from './relay-readiness.js'

function database(query: RelayDatabase['query']): RelayDatabase {
  return {
    query,
    queryLocked: query,
    transaction: (operation) => operation(database(query)),
    close: async () => {}
  }
}

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => (release = resolve))
  return { wait, release }
}

it('shares both dependency probes and caches from completion for concurrent callers', async () => {
  const sql = gate()
  let now = 1_000
  const query = vi.fn(async () => {
    await sql.wait
    return [{ ready: 1 }]
  })
  const fetchImpl = vi.fn(async () => new Response('{}'))
  const observe = vi.fn()
  const readiness = createRelayReadiness(database(query), 'https://jwks.example.test', {
    fetch: fetchImpl,
    now: () => now,
    observe
  })
  const checks = Array.from({ length: 100 }, () => readiness.check())
  try {
    expect({ sql: query.mock.calls.length, jwks: fetchImpl.mock.calls.length }).toEqual({
      sql: 1,
      jwks: 1
    })
    expect(observe).not.toHaveBeenCalled()
    now = 5_000
  } finally {
    sql.release()
  }
  expect(await Promise.all(checks)).toEqual(Array(100).fill(true))
  expect(observe).toHaveBeenCalledTimes(1)
  now = 14_999
  expect(await readiness.check()).toBe(true)
  expect(query).toHaveBeenCalledTimes(1)
  now = 15_000
  expect(await Promise.all(Array.from({ length: 100 }, () => readiness.check()))).toEqual(
    Array(100).fill(true)
  )
  expect(query).toHaveBeenCalledTimes(2)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it('shares failures, retains the failure cache, and retries after expiry', async () => {
  let healthy = false
  let now = 1_000
  const query = vi.fn(async () => {
    if (!healthy) throw new Error('offline')
    return [{ ready: 1 }]
  })
  const fetchImpl = vi.fn(async () => new Response('{}', { status: healthy ? 200 : 503 }))
  const observe = vi.fn()
  const readiness = createRelayReadiness(database(query), 'https://jwks.example.test', {
    fetch: fetchImpl,
    now: () => now,
    observe
  })
  expect(await Promise.all(Array.from({ length: 100 }, () => readiness.check()))).toEqual(
    Array(100).fill(false)
  )
  expect(query).toHaveBeenCalledTimes(1)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(observe).toHaveBeenCalledTimes(1)
  expect(readiness.degradedDependencies()).toEqual([])
  healthy = true
  now = 10_999
  expect(await readiness.check()).toBe(false)
  expect(query).toHaveBeenCalledTimes(1)
  now = 11_000
  expect(await Promise.all(Array.from({ length: 100 }, () => readiness.check()))).toEqual(
    Array(100).fill(true)
  )
  expect(query).toHaveBeenCalledTimes(2)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(observe).toHaveBeenCalledTimes(2)
})

it('keeps separate readiness owners independent', async () => {
  const query = vi.fn(async () => [{ ready: 1 }])
  const fetchImpl = vi.fn(async () => new Response('{}'))
  const first = createRelayReadiness(database(query), 'https://one.example.test', {
    fetch: fetchImpl
  })
  const second = createRelayReadiness(database(query), 'https://two.example.test', {
    fetch: fetchImpl
  })
  expect(await Promise.all([first.check(), first.check(), second.check(), second.check()])).toEqual(
    [true, true, true, true]
  )
  expect(query).toHaveBeenCalledTimes(2)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})
