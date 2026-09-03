import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Repro for #7595 post-merge bug: the reset probe must refine the breaker's
// fallback block DOWN to GitHub's real (sooner) reset. Before the fix,
// recordGhPrimaryRateLimit's extend-only Math.max discarded the sooner reset,
// so countWorkItems kept returning 0 for up to ~70s past the real reset.

const { ghExecFileAsyncMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('./gh-utils', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

import { _resetRateLimitCache } from './rate-limit'
import {
  _resetGhRateLimitBreaker,
  getGhRateLimitBlockedUntilMs,
  notifyGhPrimaryRateLimit
} from '../git/gh-rate-limit-breaker'

// Why: the reset probe is registered as a side effect of importing rate-limit.
// The static import above ensures registerGhRateLimitResetProbe has run.

function rateLimitSnapshotStdout(searchResetAtSec: number): string {
  return JSON.stringify({
    resources: {
      core: { limit: 5000, remaining: 5000, reset: searchResetAtSec + 3600 },
      search: { limit: 30, remaining: 0, reset: searchResetAtSec },
      graphql: { limit: 5000, remaining: 5000, reset: searchResetAtSec + 3600 }
    }
  })
}

beforeEach(() => {
  ghExecFileAsyncMock.mockReset()
  acquireMock.mockReset().mockResolvedValue(undefined)
  releaseMock.mockReset()
  _resetRateLimitCache()
})

afterEach(() => {
  _resetGhRateLimitBreaker()
})

describe('refineBreakerFromSnapshot refines the fallback block to the real reset', () => {
  it('lowers the search block to the real reset when it is sooner than the 70s fallback', async () => {
    const now = Date.now()
    // Real search reset in ~30s — well under the 70s fallback.
    const realResetSec = Math.floor(now / 1000) + 30
    ghExecFileAsyncMock.mockResolvedValue({ stdout: rateLimitSnapshotStdout(realResetSec) })

    // Trips the fallback block (now + 70s) and fires the reset probe.
    notifyGhPrimaryRateLimit('search')
    // The fallback overshoots the real reset before refinement lands.
    expect(getGhRateLimitBlockedUntilMs('search')!).toBeGreaterThan(realResetSec * 1000 + 5_000)

    // Let the single-flight refinement (getRateLimit + record) settle.
    await vi.waitFor(() => expect(ghExecFileAsyncMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    // After refinement the block equals the real (sooner) reset, not now+70s.
    const blockedUntil = getGhRateLimitBlockedUntilMs('search')
    expect(blockedUntil).toBe(realResetSec * 1000)
  })
})
