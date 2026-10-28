import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { harness, snapshots } from './workspace-review-subscription.test-fixture'
import { makePR } from '../github/pr-refresh-coordinator-test-harness'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { WorkspaceReviewTarget } from './runtime-workspace-review-target'

const { mocks, modules } = await vi.hoisted(async () => {
  const modules = await import('../github/pr-refresh-coordinator-test-mocks')
  return { mocks: modules.createPRRefreshCoordinatorMocks(), modules }
})
vi.mock('./runtime-desktop-surface', () => modules.runtimeDesktopSurfaceModuleMock(mocks))
vi.mock('../github/client', () => modules.clientModuleMock(mocks))
vi.mock('../github/github-api-repository', () => modules.githubApiRepositoryModuleMock(mocks))
vi.mock('../github/rate-limit', () => modules.rateLimitModuleMock(mocks))

beforeEach(() => {
  vi.useFakeTimers()
  modules.resetPRRefreshCoordinatorMocks(mocks)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('workspace review asynchronous ownership', () => {
  it('fences an old outcome as soon as a newer matching request starts', async () => {
    const h = await harness()
    let finishOld: (outcome: PRRefreshOutcome) => void = () => {}
    let finishNew: (outcome: PRRefreshOutcome) => void = () => {}
    mocks.getPRForBranchOutcomeMock
      .mockImplementationOnce(
        () =>
          new Promise<PRRefreshOutcome>((resolve) => {
            finishOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<PRRefreshOutcome>((resolve) => {
            finishNew = resolve
          })
      )
    const subscription = h.open()
    await subscription.renew()
    await vi.advanceTimersByTimeAsync(0)
    const newer = h.coordinator.refreshPRNow(h.candidate)
    await vi.advanceTimersByTimeAsync(0)
    finishOld({ kind: 'found', pr: makePR({ number: 12 }), fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.cache.pr[h.candidate.cacheKey]).toBeUndefined()
    finishNew({ kind: 'found', pr: makePR({ number: 13 }), fetchedAt: Date.now() })
    await newer
    await vi.advanceTimersByTimeAsync(0)
    expect(h.cache.pr[h.candidate.cacheKey]?.data?.number).toBe(13)
    subscription.close()
  })

  it.each(['target-change', 'same-target-renewal', 'newer-result', 'release'] as const)(
    'ignores an old event preparation failure after %s',
    async (replacement) => {
      const h = await harness()
      mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      }))
      const subscription = h.open()
      await subscription.renew()
      let fail: (error: Error) => void = () => {}
      h.prepare.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          })
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(h.prepare).toHaveBeenCalledTimes(2)
      if (replacement === 'target-change') {
        h.candidate = { ...h.candidate, branch: 'next', cacheKey: '/repo::next' }
      }
      if (replacement === 'release') {
        subscription.close()
      } else if (replacement === 'newer-result') {
        mocks.getPRForBranchOutcomeMock.mockResolvedValueOnce({
          kind: 'found',
          pr: makePR({ number: 13 }),
          fetchedAt: Date.now()
        })
        await h.coordinator.refreshPRNow(h.candidate)
        await vi.advanceTimersByTimeAsync(0)
        expect(snapshots(h.frames).at(-1)).toMatchObject({ review: { number: 13 }, stale: false })
      } else {
        await subscription.renew()
      }
      const before = [...h.frames]
      fail(new Error('superseded preparation failed'))
      await vi.advanceTimersByTimeAsync(0)
      expect(snapshots(h.frames).every((frame) => frame.error === undefined)).toBe(true)
      if (replacement !== 'target-change') {
        expect(h.frames).toEqual(before)
      }
      subscription.close()
    }
  )

  it('publishes a current event preparation failure and recovers on the next result', async () => {
    const h = await harness()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR(),
      fetchedAt: Date.now()
    }))
    const subscription = h.open()
    await subscription.renew()
    h.prepare.mockRejectedValueOnce(new Error('current preparation failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames)).toMatchObject([
      { type: 'snapshot' },
      { type: 'updated', stale: true, error: 'Review status unavailable' }
    ])
    const before = [...h.frames]
    await h.coordinator.refreshPRNow({
      ...h.candidate,
      branch: 'irrelevant',
      cacheKey: '/repo::irrelevant'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.frames).toEqual(before)
    expect(h.prepare).toHaveBeenCalledTimes(2)
    await h.coordinator.refreshPRNow(h.candidate)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: { number: 12 }, stale: false })
    expect(snapshots(h.frames).at(-1)?.error).toBeUndefined()
    subscription.close()
  })

  it('reconciles suppression changed while a same-identity lookup was running', async () => {
    const h = await harness()
    let finish: (outcome: PRRefreshOutcome) => void = () => {}
    mocks.getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise<PRRefreshOutcome>((resolve) => {
          finish = resolve
        })
    )
    const subscription = h.open()
    await subscription.renew()
    await vi.advanceTimersByTimeAsync(0)
    const current = await h.prepare()
    h.prepare.mockResolvedValue({ ...current, linkedPR: null, suppressedGitHubPR: 12 })
    finish({ kind: 'found', pr: makePR({ number: 12 }), fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: null })
    expect(h.cache.pr[h.candidate.cacheKey]?.data?.number).toBe(12)
    subscription.close()
  })

  it('does not expose a warm cache answer for a different newly linked PR', async () => {
    const h = await harness()
    h.cache = {
      pr: { [h.candidate.cacheKey]: { data: makePR({ number: 12 }), fetchedAt: Date.now() } },
      issue: {}
    }
    const initial = await h.prepare()
    h.prepare.mockResolvedValue({
      ...initial,
      linkedPR: 13,
      candidate: { ...h.candidate, linkedPRNumber: 13, cachedFetchedAt: null }
    })
    const subscription = h.open()
    await subscription.renew()
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: null, fetchedAt: null, stale: true })
    subscription.close()
  })

  it('releases setup before awaited preparation can register interest after disconnect', async () => {
    const h = await harness()
    const target = await h.prepare()
    let finish: (target: WorkspaceReviewTarget) => void = () => {}
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const subscription = h.open()
    const started = subscription.renew()
    h.registry.releaseByRequest('mobile-socket', 'mobile-1')
    finish(target)
    expect(await started).toBe(false)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.getPRForBranchOutcomeMock).not.toHaveBeenCalled()
    expect(snapshots(h.frames)).toHaveLength(0)
  })

  it('does not let an older failed renewal close a successful replacement', async () => {
    const h = await harness()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    let fail: (error: Error) => void = () => {}
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const subscription = h.open()
    const older = subscription.renew()
    expect(await subscription.renew()).toBe(true)
    expect(snapshots(h.frames)).toMatchObject([{ type: 'snapshot', review: null }])
    fail(new Error('old preparation failed'))
    expect(await older).toBe(false)
    expect(h.cleanups.size).toBe(1)
    h.prepare.mockRejectedValueOnce(new Error('current preparation failed'))
    await expect(subscription.renew()).rejects.toThrow('current preparation failed')
    expect(h.cleanups.size).toBe(0)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })

  it('starts with a snapshot after overlapping preparation and updates cache and target changes', async () => {
    const h = await harness()
    const oldTarget = await h.prepare()
    let finish: (target: WorkspaceReviewTarget) => void = () => {}
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mocks.getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 13 }),
      fetchedAt: Date.now()
    })
    const subscription = h.open()
    const older = subscription.renew()
    expect(h.frames).toHaveLength(0)
    h.candidate = { ...h.candidate, branch: 'replacement', cacheKey: '/repo::replacement' }
    expect(await subscription.renew()).toBe(true)
    finish(oldTarget)
    expect(await older).toBe(false)
    expect(snapshots(h.frames)).toMatchObject([
      { type: 'snapshot', branch: 'replacement', review: null }
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames)).toMatchObject([
      { type: 'snapshot', branch: 'replacement', review: null },
      { type: 'updated', branch: 'replacement', review: { number: 13 }, stale: false }
    ])
    h.candidate = { ...h.candidate, branch: 'next', cacheKey: '/repo::next' }
    expect(await subscription.renew()).toBe(true)
    expect(snapshots(h.frames)).toMatchObject([
      { type: 'snapshot', branch: 'replacement', review: null },
      { type: 'updated', branch: 'replacement', review: { number: 13 }, stale: false },
      { type: 'updated', branch: 'next', review: null }
    ])
    subscription.close()
  })
})
