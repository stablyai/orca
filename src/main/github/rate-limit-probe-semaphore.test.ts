import { afterEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { acquire, release } from './gh-utils'
import { _resetRateLimitCache, getRateLimit } from './rate-limit'

describe('rate-limit probe and the gh semaphore', () => {
  let held = 0

  afterEach(() => {
    for (; held > 0; held--) {
      release()
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

    let result: Awaited<ReturnType<typeof getRateLimit>> | undefined
    void getRateLimit().then((value) => {
      result = value
    })

    await vi.waitFor(() => expect(result).toBeDefined())
    expect(result).toMatchObject({
      ok: true,
      snapshot: { core: { remaining: 4000 }, graphql: { remaining: 4500 } }
    })
  })
})
