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
  MAX_INFLIGHT_LOOKUPS,
  MAX_UNSETTLED_LOOKUPS_PER_KEY
} from './hosted-review-refresh-pacing'

const identity = { repoPath: '/repo', connectionId: null, branch: 'feature/x' }
const START = 1_000_000

/** A lookup that never settles — the wedged provider this file's deadline exists for. */
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

/**
 * Runs `evictedLookup` for the shared identity, drops its in-flight record via
 * the size cap alone — no deadline, so it is a straggler that never timed out —
 * and leaves a fresh lookup owning the key.
 */
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

    // A commit is not evidence that a review was opened, so it must not defeat
    // the long interval — that is what kept busy worktrees polling every minute.
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
    // Nothing cached, so the caller must still hear a failure — but no API call.
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      /backing off/
    )
    expect(lookup).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + 60_001)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).rejects.toThrow(
      'rate limited'
    )
    expect(lookup).toHaveBeenCalledTimes(2)

    // The second failure doubles the window.
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
    // The review must not blink out on the first failure and reappear on the next
    // poll once the backoff window is what serves it.
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

    // The success clears the counter, so the next failure starts at the base
    // window again rather than resuming a doubled one. That failure is served
    // from the stale entry, but it still counts.
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
    invalidateHostedReviewBranchCache('/repo', null)

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
    invalidateHostedReviewBranchCache('/repo', null)
    // The poll started before the review existed, so its "no review" answer is
    // older than the invalidation and must not be cached back over it.
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
    invalidateHostedReviewBranchCache('/repo', null)
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

    invalidateHostedReviewBranchCache('/other', null)

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
      { ...identity, connectionId: 'ssh-1' },
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

      // Selecting the worktree is the user asking whether a review exists yet.
      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)

      // Staying on it does not re-ask; the minute interval takes over.
      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)
    })

    it('keeps a found review when a branch becomes the selection', async () => {
      const lookup = vi.fn(async () => openReview)

      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      vi.setSystemTime(1_000_000 + 1_000)
      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)

      // Only the long no-review answer is worth spending a call to retire.
      expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('caps the fast tier so a caller cannot promote a whole list', async () => {
      const lookup = vi.fn(async () => null)
      const branchAt = (index: number) => ({ ...identity, branch: `feature/${index}` })

      // One more claim than the cap allows, so the first claim is evicted.
      for (let index = 0; index <= 8; index += 1) {
        await withHostedReviewBranchCache(branchAt(index), { headOid: null, active: true }, lookup)
      }
      expect(lookup).toHaveBeenCalledTimes(9)

      vi.setSystemTime(1_000_000 + 60_001)
      // The evicted branch is back on card pacing; the newest claim is not.
      await withHostedReviewBranchCache(branchAt(0), { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(9)
      await withHostedReviewBranchCache(branchAt(8), { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(10)
    })

    it('paces a card poll of the selected branch at the selection interval', async () => {
      const lookup = vi.fn(async () => null)

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      vi.setSystemTime(1_000_000 + 60_001)

      // Freshness is a property of the branch, not of which surface asked.
      await withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      expect(lookup).toHaveBeenCalledTimes(2)
    })

    it('returns a lapsed selection to card pacing', async () => {
      const lookup = vi.fn(async () => null)

      await withHostedReviewBranchCache(identity, { headOid: null, active: true }, lookup)
      // Nothing re-asserted the selection for a full no-review interval.
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

      // The dead lookup is no longer joinable, so the branch can recover in
      // session rather than staying pinned for the life of the process.
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

      // A wedged refresh must not blank the card any more than a failing one does.
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

      // The detached call still cost the quota, so its answer is worth keeping:
      // a slow-but-alive host converges instead of failing on every poll.
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

      // A second timeout doubles the window to 120s, so the backoff outlives the
      // found-review TTL — that is what makes the escalation observable.
      await vi.advanceTimersByTimeAsync(60_001)
      const second = stuckLookup()
      const secondRejects = expect(
        withHostedReviewBranchCache(identity, { headOid: null }, second.lookup)
      ).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await secondRejects

      second.resolve(openReview)
      await vi.advanceTimersByTimeAsync(0)

      // The answer is still adopted — the call cost the quota either way — but a
      // host that only ever answers after the deadline is not healthy, so it must
      // not restart its escalation and be re-asked at the base window forever.
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

      // The refresh never outranked the answer its own callers were served, so a
      // null from a wedged host must not blank the card for a no-review interval.
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

      // A stored null reads as a fresh "no review" for the whole no-review
      // interval, so it would answer callers ahead of the running lookup.
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

      // The older attempt answers first, so landing order says nothing about which
      // answer is current — only which lookup started later does.
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

      // Both are detached, so the one that stores last is whichever host unwedged
      // last — the answer that has to survive is the one asked most recently.
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

      // The straggler settling must clear its own record, not the replacement's —
      // otherwise the next caller starts a duplicate provider call.
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
      // Why: main-process timers are suspended across a system sleep, so age —
      // not setTimeout — is what has to bound the pin.
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

      // The oldest stuck record was evicted, so its branch is no longer joinable.
      swallow(withHostedReviewBranchCache(branchAt(0), { headOid: null }, lookup))
      expect(lookup).toHaveBeenCalledTimes(MAX_INFLIGHT_LOOKUPS + 2)

      // The newest is still tracked, so concurrent callers still collapse onto it.
      swallow(
        withHostedReviewBranchCache(branchAt(MAX_INFLIGHT_LOOKUPS), { headOid: null }, lookup)
      )
      expect(lookup).toHaveBeenCalledTimes(MAX_INFLIGHT_LOOKUPS + 2)
    })

    it('does not let a cap-evicted straggler clobber the answer that replaced it', async () => {
      const evicted = stuckLookup()
      const successor = evictInflightRecord(evicted.lookup)

      // The evicted lookup never timed out, so it is a straggler on the strength
      // of the eviction alone — the successor still owns the key.
      evicted.resolve(mergedReview)
      await vi.advanceTimersByTimeAsync(0)

      // Stored, its stale answer would read as fresh and be served ahead of the
      // lookup that actually owns the branch.
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

      // One failure is one backoff doubling: the straggler's rejection must not
      // stretch the window the live retry is waiting on.
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
        // Past the longest backoff, so only the detached cap can hold the branch.
        await vi.advanceTimersByTimeAsync(LOOKUP_BACKOFF_MAX_MS + 1)
      }
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)

      // Nothing can cancel the stranded calls, so a third would leak another one
      // for the life of the process rather than recover anything.
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup)
      ).rejects.toThrow(/never answered/)
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)

      // A settling lookup frees its slot, so a host that recovers is asked again.
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
      /** Drops the branch's in-flight record without expiring it, so it runs on untracked. */
      const evictInflightRecords = (round: number): void => {
        for (let index = 0; index < MAX_INFLIGHT_LOOKUPS; index += 1) {
          swallow(
            withHostedReviewBranchCache(
              { ...identity, branch: `filler/${round}/${index}` },
              { headOid: null },
              filler.lookup
            )
          )
        }
      }

      for (let attempt = 0; attempt < MAX_UNSETTLED_LOOKUPS_PER_KEY; attempt += 1) {
        swallow(withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup))
        evictInflightRecords(attempt)
      }
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)

      // Neither has reached its deadline, so nothing is counted as detached yet —
      // but both are running with nothing able to stop them, and a third would
      // strand another provider call the same way.
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, wedged.lookup)
      ).rejects.toThrow(/never answered/)
      expect(wedged.lookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS_PER_KEY)
    })

    it('does not adopt a straggler whose invalidated scope was evicted', async () => {
      const stale = stuckLookup()
      const inflight = withHostedReviewBranchCache(identity, { headOid: null }, stale.lookup)

      invalidateHostedReviewBranchCache('/repo', null)
      // Fill the generation map so the repo's own generation is evicted: read back
      // as zero it would match what this lookup captured before the invalidation.
      for (let index = 0; index < MAX_BRANCH_MAP_ENTRIES; index += 1) {
        invalidateHostedReviewBranchCache(`/filler/${index}`, null)
      }

      stale.resolve(null)
      await expect(inflight).resolves.toBeNull()

      // Stored, that "no review" would hide the review Orca had just opened for
      // the whole no-review interval.
      const next = vi.fn(async () => openReview)
      await expect(withHostedReviewBranchCache(identity, { headOid: null }, next)).resolves.toEqual(
        openReview
      )
      expect(next).toHaveBeenCalledTimes(1)
    })
  })
})
