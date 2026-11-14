import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  __resetHostedReviewBranchCacheForTests,
  withHostedReviewBranchCache
} from './hosted-review-branch-cache'
import {
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  LOOKUP_BACKOFF_MAX_MS,
  MAX_UNSETTLED_LOOKUPS_PER_KEY
} from './hosted-review-refresh-pacing'

const identity = { repoPath: '/repo', executionHostId: 'local' as const, branch: 'feature/x' }
const START = 1_000_000

function stuckLookup() {
  let resolve: (review: HostedReviewInfo | null) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const lookup = vi.fn(
    () =>
      new Promise<HostedReviewInfo | null>((settle, fail) => {
        resolve = settle
        reject = fail
      })
  )
  return { lookup, resolve: (review) => resolve(review), reject: (error) => reject(error) }
}

const openReview: HostedReviewInfo = {
  provider: 'github',
  number: 7,
  title: 'Open PR',
  state: 'open',
  url: 'https://github.com/acme/orca/pull/7',
  status: 'success',
  updatedAt: '2026-07-31T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

const mergedReview: HostedReviewInfo = { ...openReview, state: 'merged' }

describe('hosted review branch cache (#11532)', () => {
  beforeEach(() => {
    __resetHostedReviewBranchCacheForTests()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('in-flight deadline (P1-D)', () => {
    it('does not let a timed-out null short-circuit the lookup replacing it', async () => {
      const stale = stuckLookup()
      const rejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, stale.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await rejects

      await vi.advanceTimersByTimeAsync(60_001)
      const replacement = stuckLookup()
      const pending = withHostedReviewBranchCache(identity, { headOid: null }, replacement.lookup)

      stale.resolve(null)
      await vi.advanceTimersByTimeAsync(0)

      const joiner = vi.fn(async () => null)
      const joined = withHostedReviewBranchCache(identity, { headOid: null }, joiner)

      replacement.resolve(openReview)
      await expect(pending).resolves.toEqual(openReview)
      await expect(joined).resolves.toEqual(openReview)
      expect(joiner).not.toHaveBeenCalled()
    })

    it('releases a caller by wall clock when the deadline timer never fires', async () => {
      const { lookup } = stuckLookup()

      const request = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      const rejects = expect(request).rejects.toThrow(/timed out/)
      // Wall-clock age must bound sleep-suspended timers.
      vi.setSystemTime(START + HOSTED_REVIEW_LOOKUP_DEADLINE_MS + 1)

      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      ).rejects.toThrow(/backing off/)
      await rejects
      expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('stops asking once a branch has stranded its cap of unsettled lookups', async () => {
      const wedged = stuckLookup()
      for (let attempt = 0; attempt < MAX_UNSETTLED_LOOKUPS_PER_KEY; attempt += 1) {
        const rejects = expect(
          withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup)
        ).rejects.toThrow(/timed out/)
        await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
        await rejects
        await vi.advanceTimersByTimeAsync(LOOKUP_BACKOFF_MAX_MS + 1)
      }
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)

      // A third uninterruptible lookup strands more work instead of recovering this branch.
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup)
      ).rejects.toThrow(/never answered/)
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)

      wedged.resolve(openReview)
      await vi.advanceTimersByTimeAsync(60_001)
      const recovered = vi.fn(async () => mergedReview)
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, recovered)
      ).resolves.toEqual(mergedReview)
      expect(recovered).toHaveBeenCalledTimes(1)
    })
  })
})
