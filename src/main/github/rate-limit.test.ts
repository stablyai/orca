import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { acquire, release } from './gh-utils'
import { getRateLimit, rateLimitGuard, _resetRateLimitCache } from './rate-limit'
import {
  clearGhRateLimitBlock,
  getGhRateLimitBlockedUntilMs,
  notifyGhPrimaryRateLimit,
  type GhRateLimitBucket
} from '../git/gh-rate-limit-breaker'

// Refine only the tripping host/runtime's breaker; preserve the shared native snapshot.
describe('scope-aware breaker reset probe', () => {
  const WSL_SCOPE = 'wsl:ubuntu:github.com'
  const GHES_SCOPE = 'native:github.acme-corp.com'
  const ALL_BUCKETS: GhRateLimitBucket[] = ['core', 'search', 'graphql']

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    ghExecFileAsyncMock.mockReset()
    _resetRateLimitCache()
  })

  afterEach(() => {
    // Preserve the module-load probe while clearing scoped breaker state.
    for (const scope of [WSL_SCOPE, GHES_SCOPE]) {
      for (const bucket of ALL_BUCKETS) {
        clearGhRateLimitBlock(bucket, scope)
      }
    }
    vi.useRealTimers()
  })

  async function flushProbe(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
  }

  it('refines a WSL-scope trip via a probe matching that scope', async () => {
    // Choose a reset beyond the fallback window so refinement is observable.
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 0, reset: 601 },
          search: { limit: 30, remaining: 20, reset: 601 },
          graphql: { limit: 5000, remaining: 100, reset: 601 }
        }
      })
    })

    notifyGhPrimaryRateLimit('core', WSL_SCOPE)
    notifyGhPrimaryRateLimit('core', WSL_SCOPE)
    await flushProbe()

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', 'rate_limit'], {
      encoding: 'utf-8',
      host: 'github.com',
      wslDistro: 'ubuntu'
    })
    expect(getGhRateLimitBlockedUntilMs('core', 1_000, WSL_SCOPE)).toBe(601_000)
    expect(getGhRateLimitBlockedUntilMs('search', 1_000, WSL_SCOPE)).toBeNull()
    expect(rateLimitGuard('core')).toEqual({ blocked: false })
    expect(getGhRateLimitBlockedUntilMs('core', 1_000)).toBeNull()
  })

  it('fails open on a GHES probe failure and negative-caches the scope', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('HTTP 404: Rate limiting is not enabled.'))

    notifyGhPrimaryRateLimit('core', GHES_SCOPE)
    await flushProbe()
    notifyGhPrimaryRateLimit('core', GHES_SCOPE)
    await flushProbe()

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    // Failed refinement leaves the existing fallback block in force.
    expect(getGhRateLimitBlockedUntilMs('core', 1_000, GHES_SCOPE)).toBe(301_000)

    vi.setSystemTime(1_000 + 30_000)
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        resources: { core: { limit: 5000, remaining: 4999, reset: 700 } }
      })
    })
    notifyGhPrimaryRateLimit('core', GHES_SCOPE)
    await flushProbe()

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenLastCalledWith(['api', 'rate_limit'], {
      encoding: 'utf-8',
      host: 'github.acme-corp.com'
    })
    expect(getGhRateLimitBlockedUntilMs('core', 31_000, GHES_SCOPE)).toBeNull()
  })
})

describe('rate-limit probe and the gh semaphore', () => {
  let held = 0

  afterEach(() => {
    for (; held > 0; held--) {
      release()
    }
    for (const bucket of ['core', 'search', 'graphql'] as GhRateLimitBucket[]) {
      clearGhRateLimitBlock(bucket)
    }
    _resetRateLimitCache()
  })

  // Slot holders await the budget probe; a probe queued behind them never runs.
  it('answers the probe while every gh slot is held', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 4000, reset: 2_000_000_000 },
          search: { limit: 30, remaining: 30, reset: 2_000_000_000 },
          graphql: { limit: 5000, remaining: 4500, reset: 2_000_000_000 }
        }
      })
    })
    for (let i = 0; i < 4; i++) {
      await acquire()
      held++
    }

    expect(await getRateLimit()).toMatchObject({
      ok: true,
      snapshot: { core: { remaining: 4000 }, graphql: { remaining: 4500 } }
    })
  })

  // A 403 forces a probe; joining one that started before the 403 would clear the new block.
  it('answers a forced probe with quota read after the call', async () => {
    const coreResponse = (remaining: number) => ({
      stdout: JSON.stringify({
        resources: { core: { limit: 5000, remaining, reset: 2_000_000_000 } }
      })
    })
    const first = Promise.withResolvers<{ stdout: string }>()
    const firstStarted = Promise.withResolvers<void>()
    let afterBlock: Promise<unknown> | undefined
    let phase: 'first' | 'second' | 'exhausted' = 'first'
    ghExecFileAsyncMock.mockImplementation(() => {
      if (phase === 'first') {
        phase = 'second'
        firstStarted.resolve()
        return first.promise
      }
      if (phase === 'second') {
        phase = 'exhausted'
        // This read happens before the 403 and the forced call that follows it.
        const observed = coreResponse(4000)
        notifyGhPrimaryRateLimit('core')
        afterBlock = getRateLimit({ force: true })
        return Promise.resolve(observed)
      }
      return Promise.resolve(coreResponse(0))
    })
    for (let i = 0; i < 4; i++) {
      await acquire()
      held++
    }

    const earlier = getRateLimit()
    const sharer = getRateLimit()
    const forcedDuringEarlier = getRateLimit({ force: true })
    await firstStarted.promise
    // Promise ordering delivers this forced call while the first probe is settling.
    const forcedDuringSettlement = first.promise
      .then(() => undefined)
      .then(() => undefined)
      .then(() => getRateLimit({ force: true }))
    first.resolve(coreResponse(4000))

    expect(await earlier).toMatchObject({ ok: true, snapshot: { core: { remaining: 4000 } } })
    expect(await sharer).toMatchObject({ ok: true, snapshot: { core: { remaining: 4000 } } })
    await Promise.all([forcedDuringEarlier, forcedDuringSettlement])
    expect(await afterBlock).toMatchObject({ ok: true, snapshot: { core: { remaining: 0 } } })
  })
})
