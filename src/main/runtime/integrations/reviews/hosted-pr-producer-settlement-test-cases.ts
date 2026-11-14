import { it, expect, vi, type Mock } from 'vitest'
import { makeCandidate } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type {
  PRRefreshOutcome,
  PRSnapshotReply
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

export function registerPRProducerSettlementTests({
  read,
  mocks,
  found
}: {
  read: (
    branch: string,
    reason?: 'active' | 'visible' | 'swr' | 'manual',
    head?: string
  ) => Promise<PRSnapshotReply>
  mocks: { resolve: Mock; gate: Mock }
  found: () => PRRefreshOutcome
}): void {
  it('retires a superseded producer error without waiting for or scheduling over fresh work', async () => {
    const timedProvider = Promise.withResolvers<PRRefreshOutcome>()
    const freshProvider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve
      .mockReturnValueOnce(timedProvider.promise)
      .mockReturnValueOnce(freshProvider.promise)
    const timed = read('superseded-error')
    await vi.advanceTimersByTimeAsync(0)
    const joined = read('superseded-error')
    await vi.advanceTimersByTimeAsync(0)
    const fresh = read('superseded-error', 'active')
    await vi.advanceTimersByTimeAsync(0)
    timedProvider.reject(new Error('obsolete network error'))
    expect(await Promise.all([timed, joined])).toEqual([
      { revalidation: { invalidated: true, retryAfterMs: 10_000 } },
      { revalidation: { invalidated: true, retryAfterMs: 10_000 } }
    ])
    freshProvider.resolve(found())
    const current = await fresh
    expect(await read('superseded-error')).toEqual(current)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('delivers the producer error schedule to cold pending consumers before ordinary retry', async () => {
    const { addPRRefreshOutcomeObserver } =
      await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
    const observe = vi.fn()
    const remove = addPRRefreshOutcomeObserver(observe)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const cold = read('cold-error')
    await vi.advanceTimersByTimeAsync(0)
    const joined = read('cold-error')
    await vi.advanceTimersByTimeAsync(0)
    provider.reject(new Error('network offline'))
    const results = await Promise.all([cold, joined])
    expect(results[0]).toMatchObject({
      kind: 'upstream-error',
      nextAutoRetryAt: expect.any(Number)
    })
    expect(results[1]).toEqual(results[0])
    expect(await read('cold-error')).toEqual(results[0])
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledTimes(1)
    remove()
  })

  it.each(['queued', 'immediate'] as const)(
    'keeps the %s producer policy when another active consumer joins the same task',
    async (origin) => {
      const {
        addPRRefreshOutcomeObserver,
        reportVisiblePRRefreshCandidates,
        enqueuePRRefresh,
        refreshPRNow
      } = await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
      const { setPRRefreshRendererPort } =
        await import('../../../github/pull-requests/refresh/pr-refresh-renderer-port')
      setPRRefreshRendererPort({ isRendererOpen: () => true, sendToTrustedUI: () => {} })
      const candidate = makeCandidate({
        cacheKey: '/repo::joined-active',
        repoId: 'repo',
        branch: 'joined-active',
        currentHeadOid: 'head-a',
        isSelected: true
      })
      const provider = Promise.withResolvers<PRRefreshOutcome>()
      mocks.resolve.mockReturnValueOnce(provider.promise)
      const observe = vi.fn()
      const remove = addPRRefreshOutcomeObserver(observe)
      try {
        mocks.gate.mockResolvedValue(Date.now() + 60_000)
        reportVisiblePRRefreshCandidates([candidate], 1, 1)
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).not.toHaveBeenCalled()
        mocks.gate.mockResolvedValue(null)
        let producer: Promise<PRSnapshotReply> | undefined
        if (origin === 'queued') {
          enqueuePRRefresh(candidate, 'active', 80)
        } else {
          producer = refreshPRNow(candidate, 'active')
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).toHaveBeenCalledTimes(1)
        const sibling = refreshPRNow(candidate, 'active')
        await vi.advanceTimersByTimeAsync(0)
        const hosted = read('joined-active')
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).toHaveBeenCalledTimes(1)
        provider.reject(new Error('network offline'))
        const result = await hosted
        expect(result).toMatchObject({
          kind: 'upstream-error',
          nextAutoRetryAt: expect.any(Number)
        })
        expect(await sibling).toEqual(result)
        if (producer) {
          expect(await producer).toEqual(result)
        }
        expect(await read('joined-active')).toEqual(result)
        expect(mocks.resolve).toHaveBeenCalledTimes(1)
        expect(observe).toHaveBeenCalledTimes(1)
      } finally {
        remove()
        setPRRefreshRendererPort(null)
      }
    }
  )

  it.each([false, true])(
    'observes one joined success while fencing a genuine successor (userRefresh=%s)',
    async (userRefresh) => {
      const { addPRRefreshOutcomeObserver, refreshPRNow } =
        await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
      const candidate = makeCandidate({
        cacheKey: '/repo::joined-success',
        repoId: 'repo',
        branch: 'joined-success',
        currentHeadOid: 'head-a'
      })
      const first = Promise.withResolvers<PRRefreshOutcome>()
      const successor = Promise.withResolvers<PRRefreshOutcome>()
      mocks.resolve.mockReturnValueOnce(first.promise).mockReturnValueOnce(successor.promise)
      const observe = vi.fn()
      const remove = addPRRefreshOutcomeObserver(observe)
      try {
        const producer = refreshPRNow(candidate, 'active')
        await vi.advanceTimersByTimeAsync(0)
        const sibling = refreshPRNow(candidate, 'active', { userRefresh })
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).toHaveBeenCalledTimes(userRefresh ? 2 : 1)
        const joined = read('joined-success')
        await vi.advanceTimersByTimeAsync(0)
        first.resolve(found())
        await producer
        if (userRefresh) {
          expect(observe).not.toHaveBeenCalled()
          successor.resolve(found())
        }
        const result = await sibling
        expect(await joined).toEqual(result)
        expect(result).toMatchObject({ kind: 'found' })
        expect(observe).toHaveBeenCalledTimes(1)
      } finally {
        remove()
      }
    }
  )

  it.each(['queued', 'immediate', 'headless-immediate', 'foreground'] as const)(
    'settles the %s producer before its hosted pending error consumer',
    async (origin) => {
      const { addPRRefreshOutcomeObserver, reportVisiblePRRefreshCandidates, refreshPRNow } =
        await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
      const { setPRRefreshRendererPort } =
        await import('../../../github/pull-requests/refresh/pr-refresh-renderer-port')
      if (origin === 'queued' || origin === 'immediate') {
        setPRRefreshRendererPort({ isRendererOpen: () => true, sendToTrustedUI: () => {} })
      }
      const immediate = origin === 'immediate' || origin === 'headless-immediate'
      const candidate = makeCandidate({
        cacheKey: '/repo::origin-error',
        repoId: 'repo',
        branch: 'origin-error',
        currentHeadOid: 'head-a',
        isSelected: true
      })
      const provider = Promise.withResolvers<PRRefreshOutcome>()
      mocks.resolve.mockReturnValueOnce(provider.promise)
      const observe = vi.fn()
      const remove = addPRRefreshOutcomeObserver(observe)
      try {
        let producer: Promise<PRSnapshotReply> | undefined
        if (origin === 'foreground') {
          producer = read('origin-error', 'active')
        } else {
          if (immediate) {
            mocks.gate.mockResolvedValue(Date.now() + 60_000)
          }
          reportVisiblePRRefreshCandidates([candidate], 1, 1)
          await vi.advanceTimersByTimeAsync(0)
          if (immediate) {
            expect(mocks.resolve).not.toHaveBeenCalled()
            mocks.gate.mockResolvedValue(null)
            producer = refreshPRNow(candidate, 'manual')
          }
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).toHaveBeenCalledTimes(1)
        const joined = read('origin-error')
        await vi.advanceTimersByTimeAsync(0)
        provider.reject(new Error('network offline'))
        const result = await joined
        expect(result).toMatchObject({ kind: 'upstream-error' })
        if (!('kind' in result) || result.kind !== 'upstream-error') {
          throw new Error('expected the actual provider failure')
        }
        if (origin === 'foreground' || origin === 'headless-immediate') {
          expect(result.nextAutoRetryAt).toBeUndefined()
        } else {
          expect(result.nextAutoRetryAt).toEqual(expect.any(Number))
        }
        if (producer) {
          expect(await producer).toEqual(result)
        }
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).toHaveBeenCalledTimes(1)
        expect(observe).toHaveBeenCalledTimes(1)
      } finally {
        remove()
        setPRRefreshRendererPort(null)
      }
    }
  )
}
