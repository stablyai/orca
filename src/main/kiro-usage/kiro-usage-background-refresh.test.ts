import { describe, expect, it, vi } from 'vitest'
import { KiroUsageBackgroundRefresh, type KiroUsageStore } from './kiro-usage-background-refresh'
import type { KiroUsageSnapshot } from '../../shared/kiro-usage-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const okSnapshot: KiroUsageSnapshot = {
  status: 'ok',
  error: null,
  updatedAt: 1,
  quota: { used: 132.35, limit: 1000, usedPercent: 13.2, resetsOn: '2026-10-01', plan: 'KIRO PRO' }
}

function createStore(initial: ProviderRateLimits | null = null): KiroUsageStore & {
  writes: ProviderRateLimits[]
} {
  let current = initial
  const writes: ProviderRateLimits[] = []
  return {
    writes,
    read: () => current,
    write: (limits) => {
      current = limits
      writes.push(limits)
    }
  }
}

function deferred(): { promise: Promise<KiroUsageSnapshot>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<KiroUsageSnapshot>((res) => {
    resolve = () => res(okSnapshot)
  })
  return { promise, resolve }
}

describe('KiroUsageBackgroundRefresh', () => {
  it('publishes the converted provider limits', async () => {
    const store = createStore()
    const refresh = new KiroUsageBackgroundRefresh({
      store,
      fetch: async () => okSnapshot
    })

    await refresh.requestRefresh()

    expect(store.writes).toHaveLength(1)
    expect(store.read()?.provider).toBe('kiro')
    expect(store.read()?.monthly?.usedPercent).toBe(13.2)
  })

  it('joins a concurrent caller onto the in-flight read instead of spawning a second CLI run', async () => {
    const store = createStore()
    const gate = deferred()
    const fetch = vi.fn().mockReturnValue(gate.promise)
    const refresh = new KiroUsageBackgroundRefresh({ store, fetch })

    const first = refresh.requestRefresh()
    const second = refresh.requestRefresh({ force: true })
    expect(first).toBe(second)

    gate.resolve()
    await first
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('skips a repeat read inside the freshness window but honours force', async () => {
    const store = createStore()
    const fetch = vi.fn().mockResolvedValue(okSnapshot)
    let now = 1_000
    const refresh = new KiroUsageBackgroundRefresh({
      store,
      fetch,
      now: () => now,
      ttlMs: 60_000
    })

    await refresh.requestRefresh()
    now += 1_000
    await refresh.requestRefresh()
    expect(fetch).toHaveBeenCalledTimes(1)

    await refresh.requestRefresh({ force: true })
    expect(fetch).toHaveBeenCalledTimes(2)

    now += 60_000
    await refresh.requestRefresh()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('marks an already-published provider as fetching while the read runs', async () => {
    const previous: ProviderRateLimits = {
      provider: 'kiro',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 9,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: '2026-10-01'
      },
      updatedAt: 5,
      error: null,
      status: 'ok'
    }
    const store = createStore(previous)
    const refresh = new KiroUsageBackgroundRefresh({ store, fetch: async () => okSnapshot })

    await refresh.requestRefresh()

    expect(store.writes[0]?.status).toBe('fetching')
    expect(store.writes[0]?.monthly?.usedPercent).toBe(9)
    expect(store.writes[1]?.status).toBe('ok')
  })

  it('leaves an unread provider null while fetching so no empty meter appears', async () => {
    const store = createStore()
    const gate = deferred()
    const refresh = new KiroUsageBackgroundRefresh({ store, fetch: () => gate.promise })

    const pending = refresh.requestRefresh()
    expect(store.read()).toBeNull()

    gate.resolve()
    await pending
    expect(store.read()?.status).toBe('ok')
  })

  it('keeps the last good window when a read throws', async () => {
    const previous: ProviderRateLimits = {
      provider: 'kiro',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 9,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: '2026-10-01'
      },
      updatedAt: 5,
      error: null,
      status: 'ok'
    }
    const store = createStore(previous)
    const refresh = new KiroUsageBackgroundRefresh({
      store,
      fetch: async () => {
        throw new Error('spawn failed')
      }
    })

    await expect(refresh.requestRefresh()).resolves.toBeUndefined()
    expect(store.read()).toEqual(previous)
  })
})
