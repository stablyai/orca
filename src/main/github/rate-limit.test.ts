import { afterEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { acquire, release } from './gh-utils'
import { getRateLimit, _resetRateLimitCache } from './rate-limit'
import {
  clearGhRateLimitBlock,
  notifyGhPrimaryRateLimit,
  type GhRateLimitBucket
} from '../git/command-runner/hosted-cli/gh-rate-limit-breaker'

// Refine only the tripping host/runtime's breaker; preserve the shared native snapshot.

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
