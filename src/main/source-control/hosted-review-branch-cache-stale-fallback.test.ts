import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  __resetHostedReviewBranchCacheForTests,
  withHostedReviewBranchCache
} from './hosted-review-branch-cache'
import { ACTIVE_REFRESH_INTERVAL_MS } from './hosted-review-refresh-pacing'

const identity = { repoPath: '/repo', executionHostId: 'local' as const, branch: 'feature/x' }
const display = { headOid: null, active: true }
const creation = { ...display, requireFreshAbsence: true }
const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 7,
  title: 'Existing review',
  state: 'open',
  url: 'https://git.example/team/repo/merge_requests/7',
  status: 'neutral',
  updatedAt: '',
  mergeable: 'UNKNOWN'
}
const failing = async (): Promise<HostedReviewInfo | null> => {
  throw new Error('provider down')
}

beforeEach(() => {
  __resetHostedReviewBranchCacheForTests()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  __resetHostedReviewBranchCacheForTests()
  vi.useRealTimers()
})

describe('hosted review branch cache stale fallback', () => {
  it('refuses an expired absence to creation callers when the refresh fails or backs off', async () => {
    expect(await withHostedReviewBranchCache(identity, creation, async () => null)).toBeNull()
    // Authoritative absence stays usable while fresh.
    expect(await withHostedReviewBranchCache(identity, creation, failing)).toBeNull()

    vi.advanceTimersByTime(ACTIVE_REFRESH_INTERVAL_MS + 1_000)
    await expect(withHostedReviewBranchCache(identity, creation, failing)).rejects.toThrow(
      'provider down'
    )
    // The failure started backoff, so the next read is refused without a provider call.
    const lookup = vi.fn(async () => null)
    await expect(withHostedReviewBranchCache(identity, creation, lookup)).rejects.toThrow(
      /backing off/
    )
    expect(lookup).not.toHaveBeenCalled()
    // Display callers keep their last-known answer.
    expect(await withHostedReviewBranchCache(identity, display, lookup)).toBeNull()
  })

  it('still serves an expired review to creation callers so it keeps blocking duplicates', async () => {
    await withHostedReviewBranchCache(identity, creation, async () => review)
    vi.advanceTimersByTime(ACTIVE_REFRESH_INTERVAL_MS + 1_000)
    expect(await withHostedReviewBranchCache(identity, creation, failing)).toEqual(review)
  })
})
