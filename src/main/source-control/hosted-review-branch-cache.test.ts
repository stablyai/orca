import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  __resetHostedReviewBranchCacheForTests,
  invalidateHostedReviewBranchCache,
  withHostedReviewBranchCache
} from './hosted-review-branch-cache'
import {
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  LOOKUP_BACKOFF_MAX_MS,
  MAX_BRANCH_MAP_ENTRIES,
  MAX_DETACHED_LOOKUPS,
  MAX_INFLIGHT_LOOKUPS,
  MAX_UNSETTLED_LOOKUP_KEYS,
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

/** Evict by size alone, leaving an untimed-out straggler behind a replacement owner. */
function evictInflightRecord(evictedLookup: () => Promise<HostedReviewInfo | null>) {
  const swallow = (promise: Promise<unknown>): void => {
    void promise.catch(() => {})
  }
  swallow(withHostedReviewBranchCache(identity, { headOid: null }, evictedLookup))

  const filler = stuckLookup()
  for (let index = 0; index < MAX_INFLIGHT_LOOKUPS; index += 1) {
    swallow(
      withHostedReviewBranchCache(
        { ...identity, branch: `feature/${index}` },
        { headOid: null },
        filler.lookup
      )
    )
  }

  const successor = stuckLookup()
  const request = withHostedReviewBranchCache(identity, { headOid: null }, successor.lookup)
  return { request, resolve: successor.resolve, reject: successor.reject }
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

  it('holds a no-review answer far longer than a poll interval', async () => {
    const lookup = vi.fn(async () => null)

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    vi.setSystemTime(1_000_000 + 5 * 60_000)
    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)

    expect(lookup).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + 15 * 60_000 + 1)
    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)

    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('keeps the no-review answer while the branch head moves', async () => {
    const lookup = vi.fn(async () => null)

    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    vi.setSystemTime(1_000_000 + 60_000)
    await withHostedReviewBranchCache(identity, { headOid: 'bbb' }, lookup)

    // Commits cannot prove a review was opened; they must not defeat the long no-review interval.
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('refreshes a found review at the caller cadence', async () => {
    const lookup = vi.fn(async () => openReview)

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    vi.setSystemTime(1_000_000 + 30_000)
    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + 60_001)
    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('keeps merged reviews fresh for only 60 seconds for older clients', async () => {
    const lookup = vi.fn(async () => mergedReview)
    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    vi.setSystemTime(START + 59_999)
    await withHostedReviewBranchCache(identity, { headOid: 'aaa', active: true }, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
    vi.setSystemTime(START + 60_000)
    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
    await withHostedReviewBranchCache(identity, { headOid: 'bbb' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('continues watching merged reviews whose checks are pending', async () => {
    const lookup = vi.fn(async () => ({ ...mergedReview, status: 'pending' as const }))
    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    vi.setSystemTime(START + 60_000)
    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('bypasses a merged result for an explicit refresh', async () => {
    const lookup = vi.fn(async () => mergedReview)
    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    lookup.mockResolvedValue(openReview)
    await expect(
      withHostedReviewBranchCache(identity, { headOid: 'aaa', force: true }, lookup)
    ).resolves.toEqual(openReview)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('drops a merged review once the inspected head moves off it', async () => {
    const lookup = vi.fn(async () => mergedReview)

    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    await withHostedReviewBranchCache(identity, { headOid: 'aaa' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)

    await withHostedReviewBranchCache(identity, { headOid: 'bbb' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent callers onto one lookup', async () => {
    let resolveLookup: (value: HostedReviewInfo | null) => void = () => {}
    const lookup = vi.fn(
      () =>
        new Promise<HostedReviewInfo | null>((resolve) => {
          resolveLookup = resolve
        })
    )

    const first = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    const second = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    resolveLookup(openReview)

    await expect(first).resolves.toEqual(openReview)
    await expect(second).resolves.toEqual(openReview)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('separates lookups that differ only by linked review number', async () => {
    const lookup = vi.fn(async () => null)

    await withHostedReviewBranchCache({ ...identity, linkedGitHubPR: 1 }, { headOid: null }, lookup)
    await withHostedReviewBranchCache({ ...identity, linkedGitHubPR: 2 }, { headOid: null }, lookup)

    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('backs a failing branch off instead of re-asking every poll', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('rate limited')
    })

    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      'rate limited'
    )
    vi.setSystemTime(1_000_000 + 30_000)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      /backing off/
    )
    expect(lookup).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + 60_001)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      'rate limited'
    )
    expect(lookup).toHaveBeenCalledTimes(2)

    vi.setSystemTime(1_000_000 + 60_001 + 60_000)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      /backing off/
    )
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('serves the last known review from the failure itself, not only the backoff', async () => {
    const lookup = vi
      .fn<() => Promise<HostedReviewInfo | null>>()
      .mockResolvedValueOnce(openReview)
      .mockRejectedValueOnce(new Error('transient'))

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    vi.setSystemTime(1_000_000 + 60_001)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      openReview
    )

    vi.setSystemTime(1_000_000 + 60_001 + 1_000)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      openReview
    )
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('resets the escalation once a lookup succeeds', async () => {
    const lookup = vi
      .fn<() => Promise<HostedReviewInfo | null>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(openReview)
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue(mergedReview)

    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      'first'
    )
    vi.setSystemTime(1_000_000 + 60_001)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      openReview
    )

    // Success resets escalation; the next failed refresh starts at base even when serving stale data.
    vi.setSystemTime(1_000_000 + 2 * 60_001)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      openReview
    )
    vi.setSystemTime(1_000_000 + 3 * 60_001)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      mergedReview
    )
    expect(lookup).toHaveBeenCalledTimes(4)
  })

  it('retires a cached no-review answer when Orca opens a review', async () => {
    const lookup = vi
      .fn<() => Promise<HostedReviewInfo | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(openReview)

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    invalidateHostedReviewBranchCache('/repo', 'local')

    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      openReview
    )
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('discards a lookup that was already in flight when Orca opened a review', async () => {
    let resolveLookup: (value: HostedReviewInfo | null) => void = () => {}
    const lookup = vi
      .fn<() => Promise<HostedReviewInfo | null>>()
      .mockImplementationOnce(
        () =>
          new Promise<HostedReviewInfo | null>((resolve) => {
            resolveLookup = resolve
          })
      )
      .mockResolvedValue(openReview)

    const inflight = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    invalidateHostedReviewBranchCache('/repo', 'local')
    // Creation invalidation outranks this pre-review lookup's stale null.
    resolveLookup(null)
    await expect(inflight).resolves.toBeNull()

    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      openReview
    )
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('leaves another repo in-flight lookup cacheable across an invalidation', async () => {
    let resolveLookup: (value: HostedReviewInfo | null) => void = () => {}
    const other = { ...identity, repoPath: '/other' }
    const lookup = vi.fn<() => Promise<HostedReviewInfo | null>>().mockImplementationOnce(
      () =>
        new Promise<HostedReviewInfo | null>((resolve) => {
          resolveLookup = resolve
        })
    )

    const inflight = withHostedReviewBranchCache(other, { headOid: null }, lookup)
    invalidateHostedReviewBranchCache('/repo', 'local')
    resolveLookup(null)
    await inflight

    await withHostedReviewBranchCache(other, { headOid: null }, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('scopes invalidation to one repo', async () => {
    const lookup = vi.fn(async () => null)

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    await withHostedReviewBranchCache(
      { ...identity, repoPath: '/other' },
      { headOid: null },
      lookup
    )
    expect(lookup).toHaveBeenCalledTimes(2)

    invalidateHostedReviewBranchCache('/other', 'local')

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
    await withHostedReviewBranchCache(
      { ...identity, repoPath: '/other' },
      { headOid: null },
      lookup
    )
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('keeps SSH and local repos with the same path apart', async () => {
    const lookup = vi.fn(async () => null)

    await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
    await withHostedReviewBranchCache(
      { ...identity, executionHostId: 'ssh:ssh-1' as const },
      { headOid: null },
      lookup
    )

    expect(lookup).toHaveBeenCalledTimes(2)
  })

  describe('selected-worktree tier', () => {
    it('re-checks the selected branch every minute while the card list waits', async () => {
      const selected = vi.fn(async () => null)
      const listed = vi.fn(async () => null)
      const other = { ...identity, branch: 'feature/y' }

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, selected)
      await withHostedReviewBranchCache(other, { headOid: null }, listed)

      vi.setSystemTime(1_000_000 + 60_001)
      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, selected)
      await withHostedReviewBranchCache(other, { headOid: null }, listed)

      expect(selected).toHaveBeenCalledTimes(2)
      expect(listed).toHaveBeenCalledTimes(1)
    })

    it('retires a cached no-review answer when a branch becomes the selection', async () => {
      const lookup = vi.fn(async () => null)

      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      vi.setSystemTime(1_000_000 + 1_000)

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)
    })

    it('keeps a found review when a branch becomes the selection', async () => {
      const lookup = vi.fn(async () => openReview)

      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      vi.setSystemTime(1_000_000 + 1_000)
      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)

      expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('caps the fast tier so a caller cannot promote a whole list', async () => {
      const lookup = vi.fn(async () => null)
      const branchAt = (index: number) => ({ ...identity, branch: `feature/${index}` })

      for (let index = 0; index <= 8; index += 1) {
        await withHostedReviewBranchCache(branchAt(index), { headOid: null, active: true }, lookup)
      }
      expect(lookup).toHaveBeenCalledTimes(9)

      vi.setSystemTime(1_000_000 + 60_001)
      await withHostedReviewBranchCache(branchAt(0), { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(9)
      await withHostedReviewBranchCache(branchAt(8), { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(10)
    })

    it('paces a card poll of the selected branch at the selection interval', async () => {
      const lookup = vi.fn(async () => null)

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      vi.setSystemTime(1_000_000 + 60_001)

      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)
    })

    it('returns a lapsed selection to card pacing', async () => {
      const lookup = vi.fn(async () => null)

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      vi.setSystemTime(1_000_000 + 15 * 60_000 + 1)
      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)

      vi.setSystemTime(1_000_000 + 15 * 60_000 + 1 + 60_001)
      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)
    })
  })

  describe('in-flight deadline (P1-D)', () => {
    it('releases a stuck lookup at the deadline instead of pinning the branch', async () => {
      const { lookup } = stuckLookup()

      const request = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      const rejects = expect(request).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await rejects

      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      ).rejects.toThrow(/backing off/)
      expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('lets a later poll succeed after a lookup times out', async () => {
      const { lookup } = stuckLookup()

      const rejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await rejects

      await vi.advanceTimersByTimeAsync(60_001)
      const recovered = vi.fn(async () => openReview)
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, recovered)
      ).resolves.toEqual(openReview)
      expect(recovered).toHaveBeenCalledTimes(1)
    })

    it('keeps the last known review when a refresh times out', async () => {
      await withHostedReviewBranchCache(identity, { headOid: null }, async () => openReview)
      vi.setSystemTime(START + 60_001)

      const { lookup } = stuckLookup()
      const request = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)

      await expect(request).resolves.toEqual(openReview)
    })

    it('adopts a lookup that lands after its deadline', async () => {
      const { lookup, resolve } = stuckLookup()

      const rejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await rejects

      resolve(openReview)
      await vi.advanceTimersByTimeAsync(0)

      // Late answers still spent quota; adopt them when safe so slow hosts can converge.
      const next = vi.fn(async () => null)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        openReview
      )
      expect(next).not.toHaveBeenCalled()
    })

    it('keeps escalating when a lookup only ever answers past its deadline', async () => {
      const first = stuckLookup()
      const firstRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, first.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await firstRejects

      // A second timeout backs off longer than found-review TTL, exposing escalation.
      await vi.advanceTimersByTimeAsync(60_001)
      const second = stuckLookup()
      const secondRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, second.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await secondRejects

      second.resolve(openReview)
      await vi.advanceTimersByTimeAsync(0)

      // Adopt safe late data without treating missed deadlines as provider recovery.
      await vi.advanceTimersByTimeAsync(60_001)
      const recovered = vi.fn(async () => mergedReview)
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, recovered)
      ).resolves.toEqual(openReview)
      expect(recovered).not.toHaveBeenCalled()
    })

    it('does not let a timed-out null wipe the open review it was refreshing', async () => {
      await withHostedReviewBranchCache(identity, { headOid: null }, async () => openReview)
      await vi.advanceTimersByTimeAsync(60_001)

      const stale = stuckLookup()
      const request = withHostedReviewBranchCache(identity, { headOid: null }, stale.lookup)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await expect(request).resolves.toEqual(openReview)

      stale.resolve(null)
      await vi.advanceTimersByTimeAsync(0)

      // A timed-out refresh must not replace its served answer with a long-lived null.
      const next = vi.fn(async () => openReview)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        openReview
      )
      expect(next).not.toHaveBeenCalled()
    })

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

    it('lets a newer straggler supersede an older one that landed first', async () => {
      const first = stuckLookup()
      const firstRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, first.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await firstRejects

      await vi.advanceTimersByTimeAsync(60_001)
      const second = stuckLookup()
      const secondRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, second.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await secondRejects

      // Completion order cannot establish freshness; lookup start order does.
      first.resolve(null)
      await vi.advanceTimersByTimeAsync(0)
      second.resolve(openReview)
      await vi.advanceTimersByTimeAsync(0)

      const next = vi.fn(async () => null)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        openReview
      )
      expect(next).not.toHaveBeenCalled()
    })

    it('does not let an older straggler overwrite a newer one that landed first', async () => {
      const first = stuckLookup()
      const firstRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, first.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await firstRejects

      await vi.advanceTimersByTimeAsync(60_001)
      const second = stuckLookup()
      const secondRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, second.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await secondRejects

      // Even when both detach, retain the answer asked most recently.
      second.resolve(openReview)
      await vi.advanceTimersByTimeAsync(0)
      first.resolve(null)
      await vi.advanceTimersByTimeAsync(0)

      const next = vi.fn(async () => null)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        openReview
      )
      expect(next).not.toHaveBeenCalled()
    })

    it('does not let a straggler overwrite an answer newer than itself', async () => {
      const stale = stuckLookup()
      const rejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, stale.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await rejects

      await vi.advanceTimersByTimeAsync(60_001)
      await withHostedReviewBranchCache(identity, { headOid: null }, async () => mergedReview)

      stale.resolve(openReview)
      await vi.advanceTimersByTimeAsync(0)

      const next = vi.fn(async () => null)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        mergedReview
      )
      expect(next).not.toHaveBeenCalled()
    })

    it('does not let a straggler evict the lookup that replaced it', async () => {
      const stale = stuckLookup()
      const rejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, stale.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await rejects

      await vi.advanceTimersByTimeAsync(60_001)
      const replacement = stuckLookup()
      const first = withHostedReviewBranchCache(identity, { headOid: null }, replacement.lookup)

      // A straggler must clear only its own record or the next reader starts a duplicate call.
      stale.reject(new Error('late failure'))
      await vi.advanceTimersByTimeAsync(0)

      const second = withHostedReviewBranchCache(identity, { headOid: null }, replacement.lookup)
      replacement.resolve(openReview)

      await expect(first).resolves.toEqual(openReview)
      await expect(second).resolves.toEqual(openReview)
      expect(replacement.lookup).toHaveBeenCalledTimes(1)
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

    it('bounds the in-flight map independently of the completed cache', async () => {
      const { lookup } = stuckLookup()
      const branchAt = (index: number) => ({ ...identity, branch: `feature/${index}` })
      const swallow = (promise: Promise<unknown>): void => {
        void promise.catch(() => {})
      }

      for (let index = 0; index <= MAX_INFLIGHT_LOOKUPS; index += 1) {
        swallow(withHostedReviewBranchCache(branchAt(index), { headOid: null }, lookup))
      }
      expect(lookup).toHaveBeenCalledTimes(MAX_INFLIGHT_LOOKUPS + 1)

      swallow(withHostedReviewBranchCache(branchAt(0), { headOid: null }, lookup))
      expect(lookup).toHaveBeenCalledTimes(MAX_INFLIGHT_LOOKUPS + 2)

      swallow(
        withHostedReviewBranchCache(branchAt(MAX_INFLIGHT_LOOKUPS), { headOid: null }, lookup)
      )
      expect(lookup).toHaveBeenCalledTimes(MAX_INFLIGHT_LOOKUPS + 2)
    })

    it('does not let a cap-evicted straggler clobber the answer that replaced it', async () => {
      const evicted = stuckLookup()
      const successor = evictInflightRecord(evicted.lookup)

      // Size eviction alone creates a straggler; it must not displace its successor.
      evicted.resolve(mergedReview)
      await vi.advanceTimersByTimeAsync(0)

      const joiner = vi.fn(async () => null)
      const joined = withHostedReviewBranchCache(identity, { headOid: null }, joiner)

      successor.resolve(openReview)
      await expect(successor.request).resolves.toEqual(openReview)
      await expect(joined).resolves.toEqual(openReview)
      expect(joiner).not.toHaveBeenCalled()
    })

    it('does not let a cap-evicted straggler double-count its successor failure', async () => {
      const evicted = stuckLookup()
      const successor = evictInflightRecord(evicted.lookup)

      evicted.reject(new Error('late failure'))
      await vi.advanceTimersByTimeAsync(0)

      successor.reject(new Error('successor failure'))
      await expect(successor.request).rejects.toThrow('successor failure')

      // Late rejection must not count a second backoff failure.
      await vi.advanceTimersByTimeAsync(60_001)
      const recovered = vi.fn(async () => openReview)
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, recovered)
      ).resolves.toEqual(openReview)
      expect(recovered).toHaveBeenCalledTimes(1)
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

    it('counts a lookup that is still running against the branch cap', async () => {
      const swallow = (promise: Promise<unknown>): void => {
        void promise.catch(() => {})
      }
      const filler = stuckLookup()
      const wedged = stuckLookup()
      /** Evict without timeout; reuse filler keys so the in-flight cap fires before unsettled-key admission. */
      const evictInflightRecords = (): void => {
        for (let index = 0; index < MAX_INFLIGHT_LOOKUPS; index += 1) {
          swallow(
            withHostedReviewBranchCache(
              { ...identity, branch: `filler/${index}` },
              { headOid: null },
              filler.lookup
            )
          )
        }
      }

      for (let attempt = 0; attempt < MAX_UNSETTLED_LOOKUPS_PER_KEY; attempt += 1) {
        swallow(withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup))
        evictInflightRecords()
      }
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)

      // Size-evicted calls are still live before their deadlines; admission must count them.
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup)
      ).rejects.toThrow(/never answered/)
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)
    })

    it('stops admitting new branches once the unsettled map is full', async () => {
      const swallow = (promise: Promise<unknown>): void => {
        void promise.catch(() => {})
      }
      const filler = stuckLookup()
      for (let index = 0; index < MAX_UNSETTLED_LOOKUP_KEYS; index += 1) {
        swallow(
          withHostedReviewBranchCache(
            { ...identity, branch: `filler/${index}` },
            { headOid: null },
            filler.lookup
          )
        )
      }
      expect(filler.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUP_KEYS)

      // Bound new keys before deadline detachment; fresh branches must not be blamed for a lookup they never started.
      const fresh = vi.fn(async () => openReview)
      const refusal = await withHostedReviewBranchCache(
        { ...identity, branch: 'fresh' },
        { headOid: null },
        fresh
      ).catch((error: unknown) => (error as Error).message)
      expect(refusal).toMatch(/Too many hosted review lookups are already in progress/)
      expect(refusal).not.toMatch(/never answered/)
      expect(fresh).not.toHaveBeenCalled()

      // The map cap blocks new keys, not recovery retries for existing ones.
      const retry = stuckLookup()
      swallow(
        withHostedReviewBranchCache(
          { ...identity, branch: 'filler/0' },
          { headOid: null },
          retry.lookup
        )
      )
      expect(retry.lookup).toHaveBeenCalledTimes(1)
    })

    it('names the process-wide cap when abandoned lookups have filled it', async () => {
      const wedged = stuckLookup()
      for (let index = 0; index < MAX_DETACHED_LOOKUPS; index += 1) {
        void withHostedReviewBranchCache(
          { ...identity, branch: `wedged/${index}` },
          { headOid: null },
          wedged.lookup
        ).catch(() => {})
      }
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)

      const fresh = vi.fn(async () => openReview)
      const refusal = await withHostedReviewBranchCache(
        { ...identity, branch: 'fresh' },
        { headOid: null },
        fresh
      ).catch((error: unknown) => (error as Error).message)
      expect(refusal).toMatch(/abandoned without answering/)
      expect(fresh).not.toHaveBeenCalled()
    })

    it('does not adopt a straggler whose invalidated scope was evicted', async () => {
      const stale = stuckLookup()
      const inflight = withHostedReviewBranchCache(identity, { headOid: null }, stale.lookup)

      invalidateHostedReviewBranchCache('/repo', 'local')
      // After generation-map eviction, zero would alias an invalidated lookup's captured generation.
      for (let index = 0; index < MAX_BRANCH_MAP_ENTRIES; index += 1) {
        invalidateHostedReviewBranchCache(`/filler/${index}`, 'local')
      }

      stale.resolve(null)
      await expect(inflight).resolves.toBeNull()

      const next = vi.fn(async () => openReview)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        openReview
      )
      expect(next).toHaveBeenCalledTimes(1)
    })
  })
})
