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
