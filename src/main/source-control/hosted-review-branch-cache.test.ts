import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  __resetHostedReviewBranchCacheForTests,
  invalidateHostedReviewBranchCache,
  withHostedReviewBranchCache
} from './hosted-review-branch-cache'

const identity = { repoPath: '/repo', connectionId: null, branch: 'feature/x' }

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
})
