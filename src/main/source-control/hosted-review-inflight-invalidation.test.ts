import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  __resetHostedReviewBranchCacheForTests,
  invalidateHostedReviewBranchCache,
  withHostedReviewBranchCache
} from './hosted-review-branch-cache'
import {
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  MAX_UNSETTLED_LOOKUP_KEYS,
  MAX_UNSETTLED_LOOKUPS_PER_KEY
} from './hosted-review-refresh-pacing'

const identity = {
  repoPath: '/repo',
  executionHostId: 'ssh:host-a' as const,
  branch: 'feature/review',
  localGitExecOptions: { admissionTier: 'background' }
}
const options = { headOid: null }
const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 7,
  title: 'Created review',
  state: 'open',
  url: 'https://git.example/team/repo/merge_requests/7',
  status: 'neutral',
  updatedAt: '',
  mergeable: 'UNKNOWN'
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

describe('hosted review in-flight invalidation', () => {
  it.each(['before', 'after'] as const)(
    'refreshes post-create readers when the old request finishes %s its replacement',
    async (completionOrder) => {
      const oldResponse = Promise.withResolvers<HostedReviewInfo | null>()
      const freshResponse = Promise.withResolvers<HostedReviewInfo | null>()
      const oldLookup = vi.fn(() => oldResponse.promise)
      const freshLookup = vi.fn(() => freshResponse.promise)
      const admitted = withHostedReviewBranchCache(identity, options, oldLookup)
      expect(
        await withHostedReviewBranchCache(
          { ...identity, localGitExecOptions: { admissionTier: 'interactive' } },
          options,
          async () => null
        )
      ).toBeNull()

      invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
      const next = withHostedReviewBranchCache(identity, options, freshLookup)
      const concurrent = withHostedReviewBranchCache(identity, options, freshLookup)
      try {
        expect(freshLookup).toHaveBeenCalledTimes(1)
        if (completionOrder === 'before') {
          oldResponse.resolve(null)
          expect(await admitted).toBeNull()
        }
        freshResponse.resolve(review)
        expect(await next).toEqual(review)
        expect(await concurrent).toEqual(review)
        if (completionOrder === 'after') {
          oldResponse.resolve(null)
          expect(await admitted).toBeNull()
        }
        expect(await withHostedReviewBranchCache(identity, options, freshLookup)).toEqual(review)
        expect(oldLookup).toHaveBeenCalledTimes(1)
        expect(freshLookup).toHaveBeenCalledTimes(1)
      } finally {
        oldResponse.resolve(null)
        freshResponse.resolve(review)
        await Promise.all([admitted, next, concurrent])
      }
    }
  )

  it('does not make a post-create reader wait for a stale request deadline', async () => {
    const oldResponse = Promise.withResolvers<HostedReviewInfo | null>()
    const admitted = withHostedReviewBranchCache(identity, options, () => oldResponse.promise)
    const admittedResult = admitted.catch(() => null)
    await vi.advanceTimersByTimeAsync(10_000)
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    const freshLookup = vi.fn(async () => review)
    let settled = false
    const next = withHostedReviewBranchCache(identity, options, freshLookup).then((value) => {
      settled = true
      return value
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect(await next).toEqual(review)
      expect(freshLookup).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS - 10_000)
      expect(await admittedResult).toEqual(review)
      expect(await withHostedReviewBranchCache(identity, options, freshLookup)).toEqual(review)
      expect(freshLookup).toHaveBeenCalledTimes(2)
    } finally {
      oldResponse.resolve(null)
      await Promise.all([admittedResult, next])
    }
  })

  it('discards a retired answer that landed with no replacement to outrank it', async () => {
    const oldResponse = Promise.withResolvers<HostedReviewInfo | null>()
    const admitted = withHostedReviewBranchCache(identity, options, () => oldResponse.promise)
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    // Scope generation must fence this pre-invalidation null even without a replacement owner.
    oldResponse.resolve(null)
    expect(await admitted).toBeNull()
    const freshLookup = vi.fn(async () => review)
    expect(await withHostedReviewBranchCache(identity, options, freshLookup)).toEqual(review)
    expect(freshLookup).toHaveBeenCalledTimes(1)
  })

  it('keeps other hosts, paths and their pending promises isolated', async () => {
    const others = [
      { ...identity, executionHostId: 'local' as const },
      { ...identity, executionHostId: 'ssh:host-b' as const },
      { ...identity, repoPath: '/repo-other' }
    ].map((key) => {
      const response = Promise.withResolvers<HostedReviewInfo | null>()
      const lookup = vi.fn(() => response.promise)
      return { key, response, lookup, admitted: withHostedReviewBranchCache(key, options, lookup) }
    })
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    const readers = others.map(({ key, lookup }) =>
      withHostedReviewBranchCache(key, options, lookup)
    )
    for (const other of others) {
      expect(other.lookup).toHaveBeenCalledTimes(1)
      other.response.resolve(review)
    }
    expect(await Promise.all(readers)).toEqual([review, review, review])
    await Promise.all(others.map((other) => other.admitted))
  })

  it('sweeps invalidated readers after sleep without expiring their replacement', async () => {
    const oldResponse = Promise.withResolvers<HostedReviewInfo | null>()
    const freshResponse = Promise.withResolvers<HostedReviewInfo | null>()
    const admitted = withHostedReviewBranchCache(identity, options, () => oldResponse.promise)
    const admittedResult = admitted.catch((error: unknown) => error)
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    vi.setSystemTime(Date.now() + 90_000)
    const freshLookup = vi.fn(() => freshResponse.promise)
    const replacement = withHostedReviewBranchCache(identity, options, freshLookup).catch(
      (error: unknown) => error
    )
    vi.setSystemTime(Date.now() + 40_000)
    const joined = withHostedReviewBranchCache(identity, options, freshLookup).catch(
      (error: unknown) => error
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(await admittedResult).toMatchObject({
        message: expect.stringContaining('timed out')
      })
      expect(freshLookup).toHaveBeenCalledTimes(1)
      freshResponse.resolve(review)
      expect(await replacement).toEqual(review)
      expect(await joined).toEqual(review)
      oldResponse.resolve(null)
      expect(await withHostedReviewBranchCache(identity, options, freshLookup)).toEqual(review)
      expect(freshLookup).toHaveBeenCalledTimes(1)
    } finally {
      oldResponse.resolve(null)
      freshResponse.resolve(review)
      await Promise.all([admittedResult, replacement, joined])
    }
  })

  it('keeps the two-unsettled-request cap across repeated invalidation', async () => {
    const first = Promise.withResolvers<HostedReviewInfo | null>()
    const second = Promise.withResolvers<HostedReviewInfo | null>()
    const firstRead = withHostedReviewBranchCache(identity, options, () => first.promise)
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    const secondRead = withHostedReviewBranchCache(identity, options, () => second.promise)
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    const thirdLookup = vi.fn(async () => review)
    const third = withHostedReviewBranchCache(identity, options, thirdLookup)
    const thirdResult = third.catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(thirdLookup).not.toHaveBeenCalled()
      first.resolve(null)
      second.resolve(null)
      await Promise.all([firstRead, secondRead])
      expect(await thirdResult).toMatchObject({
        message: expect.stringContaining('never answered')
      })
      expect(await withHostedReviewBranchCache(identity, options, thirdLookup)).toEqual(review)
      expect(thirdLookup).toHaveBeenCalledTimes(1)
    } finally {
      first.resolve(null)
      second.resolve(null)
      await Promise.all([firstRead, secondRead, thirdResult])
    }
  })

  it('does not let an invalidated rejection penalize the replacement', async () => {
    const oldResponse = Promise.withResolvers<HostedReviewInfo | null>()
    const freshResponse = Promise.withResolvers<HostedReviewInfo | null>()
    const admitted = withHostedReviewBranchCache(identity, options, () => oldResponse.promise)
    const rejected = expect(admitted).rejects.toThrow('old lookup failed')
    invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
    const fresh = withHostedReviewBranchCache(identity, options, () => freshResponse.promise)
    oldResponse.reject(new Error('old lookup failed'))
    await rejected
    freshResponse.resolve(review)
    expect(await fresh).toEqual(review)
    await vi.advanceTimersByTimeAsync(60_001)
    const next = vi.fn(async () => review)
    expect(await withHostedReviewBranchCache(identity, options, next)).toEqual(review)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('bounds retired owners by admission and sweeps all of them after sleep', async () => {
    const requests: ReturnType<typeof Promise.withResolvers<HostedReviewInfo | null>>[] = []
    const readers: Promise<unknown>[] = []
    for (let index = 0; index < MAX_UNSETTLED_LOOKUP_KEYS; index += 1) {
      for (let attempt = 0; attempt < MAX_UNSETTLED_LOOKUPS_PER_KEY; attempt += 1) {
        const response = Promise.withResolvers<HostedReviewInfo | null>()
        requests.push(response)
        readers.push(
          withHostedReviewBranchCache(
            { ...identity, branch: `branch-${index}` },
            options,
            () => response.promise
          ).catch((error: unknown) => error)
        )
        invalidateHostedReviewBranchCache(identity.repoPath, identity.executionHostId)
      }
    }
    const freshLookup = vi.fn(async () => review)
    try {
      await expect(withHostedReviewBranchCache(identity, options, freshLookup)).rejects.toThrow(
        'Too many hosted review lookups are already in progress'
      )
      expect(freshLookup).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(MAX_UNSETTLED_LOOKUP_KEYS * MAX_UNSETTLED_LOOKUPS_PER_KEY)
      vi.setSystemTime(Date.now() + HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      await expect(withHostedReviewBranchCache(identity, options, freshLookup)).rejects.toThrow()
      expect(vi.getTimerCount()).toBe(0)
      expect(await Promise.all(readers)).toEqual(
        requests.map(() =>
          expect.objectContaining({ message: expect.stringContaining('timed out') })
        )
      )
    } finally {
      for (const response of requests) {
        response.resolve(null)
      }
      await Promise.all(readers)
    }
    expect(await withHostedReviewBranchCache(identity, options, freshLookup)).toEqual(review)
    expect(freshLookup).toHaveBeenCalledTimes(1)
  })
})

const START = 1_000_000
const openReview = review
const mergedReview: HostedReviewInfo = { ...review, state: 'merged' }
function stuckLookup() {
  const response = Promise.withResolvers<HostedReviewInfo | null>()
  return {
    lookup: vi.fn(() => response.promise),
    resolve: response.resolve,
    reject: response.reject
  }
}
describe('hosted review manual refresh invalidation', () => {
  // The branch cache never branches on the forge, so one stands for all of them.
  it('starts a post-click read and fences the pre-click answer at the same clock time', async () => {
    const old = stuckLookup()
    const before = withHostedReviewBranchCache(identity, { headOid: null, force: true }, old.lookup)
    const lookup = vi.fn(async () => mergedReview)
    const options = { headOid: null, force: true, userRefresh: true }
    const click = withHostedReviewBranchCache(identity, options, lookup)
    old.resolve(openReview)
    await expect(before).resolves.toMatchObject({ state: 'open' })
    await expect(click).resolves.toEqual(mergedReview)
    expect(lookup).toHaveBeenCalledOnce()
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, lookup)).resolves.toEqual(
      mergedReview
    )
  })

  it('fences a pre-click answer that completes after the manual answer', async () => {
    const old = stuckLookup()
    const before = withHostedReviewBranchCache(identity, { headOid: null }, old.lookup)
    await expect(
      withHostedReviewBranchCache(
        identity,
        { headOid: null, force: true, userRefresh: true },
        async () => mergedReview
      )
    ).resolves.toEqual(mergedReview)
    old.resolve(openReview)
    await before
    await expect(
      withHostedReviewBranchCache(identity, { headOid: null }, async () => openReview)
    ).resolves.toEqual(mergedReview)
  })

  it('reads during failure backoff only for an explicit click, then recovers', async () => {
    await withHostedReviewBranchCache(identity, { headOid: null }, async () => openReview)
    const failed = vi.fn(async () => {
      throw new Error('offline')
    })
    await withHostedReviewBranchCache(identity, { headOid: null, force: true }, failed)
    const lookup = vi.fn(async () => mergedReview)
    await expect(
      withHostedReviewBranchCache(identity, { headOid: null, force: true }, lookup)
    ).resolves.toEqual(openReview)
    expect(lookup).not.toHaveBeenCalled()
    const options = { headOid: null, force: true, userRefresh: true }
    await expect(withHostedReviewBranchCache(identity, options, failed)).rejects.toThrow('offline')
    await expect(withHostedReviewBranchCache(identity, options, lookup)).resolves.toEqual(
      mergedReview
    )
    expect(lookup).toHaveBeenCalledOnce()
  })

  it.each(['failure', 'deadline'] as const)(
    'settles a shared manual flight per caller on %s',
    async (outcome) => {
      await withHostedReviewBranchCache(identity, { headOid: null }, async () => openReview)
      const held = stuckLookup()
      const options = { headOid: null, force: true, userRefresh: true }
      const click = withHostedReviewBranchCache(identity, options, held.lookup)
      const rejection = expect(click).rejects.toThrow(
        outcome === 'failure' ? 'offline' : 'timed out'
      )
      const ordinary = withHostedReviewBranchCache(
        identity,
        { headOid: null, force: true },
        held.lookup
      )
      if (outcome === 'failure') {
        held.reject(new Error('offline'))
      } else {
        await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
      }
      await rejection
      await expect(ordinary).resolves.toEqual(openReview)
      expect(held.lookup).toHaveBeenCalledOnce()
      // Failed refreshes cannot renew the old answer's TTL or reset failure escalation.
      vi.setSystemTime(START + HOSTED_REVIEW_LOOKUP_DEADLINE_MS + 60_001)
      const next = vi.fn(async () => mergedReview)
      await withHostedReviewBranchCache(identity, { headOid: null }, next)
      expect(next).toHaveBeenCalledOnce()
      if (outcome === 'deadline') {
        held.resolve(openReview)
      }
    }
  )

  it('refuses a third live click without retiring the admitted successor', async () => {
    const first = stuckLookup()
    const second = stuckLookup()
    const options = { headOid: null, force: true, userRefresh: true }
    const before = withHostedReviewBranchCache(
      identity,
      { headOid: null, force: true },
      first.lookup
    )
    const admitted = withHostedReviewBranchCache(identity, options, second.lookup)
    const third = vi.fn(async () => openReview)
    const refused = withHostedReviewBranchCache(identity, options, third)
    const rejection = expect(refused).rejects.toThrow('still running')
    second.resolve(mergedReview)
    first.resolve(openReview)
    await rejection
    await expect(admitted).resolves.toEqual(mergedReview)
    await before
    expect(third).not.toHaveBeenCalled()
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, third)).resolves.toEqual(
      mergedReview
    )
  })
})
