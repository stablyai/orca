import { harness, snapshots } from './workspace-review-subscription.test-fixture'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceReviewTarget } from './runtime-workspace-review-target'
import { makePR } from '../github/pr-refresh-coordinator-test-harness'

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

describe('workspace review interest shares the desktop refresh owner', () => {
  it('starts once for desktop and concurrent mobile mounts, reuses fresh results on renewal, and retains freshness', async () => {
    const h = await harness()
    mocks.getAllWebContentsMock.mockReturnValue([{ id: 1, isDestroyed: () => false }])
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR(),
      fetchedAt: Date.now()
    }))
    h.coordinator.reportVisiblePRRefreshCandidates([h.candidate], 1, 1)
    const first = h.open()
    const second = h.open('mobile-2')
    await Promise.all([first.renew(), second.renew()])
    expect(snapshots(h.frames)[0]).toMatchObject({ review: null, fetchedAt: null, stale: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(snapshots(h.frames).at(-1)).toMatchObject({
      review: { number: 12, checksStatus: 'pending' },
      stale: false,
      fetchedAt: 1000
    })
    await vi.advanceTimersByTimeAsync(20_000)
    await Promise.all([first.renew(), second.renew(), first.renew()])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    first.close()
    second.close()
    h.coordinator.clearVisiblePRRefreshWindow(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('releases on disconnect and expiry without starting another GitHub lookup', async () => {
    const h = await harness()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    const abort = new AbortController()
    const first = h.open('mobile-1', abort.signal)
    await first.renew()
    await vi.advanceTimersByTimeAsync(0)
    h.registry.cleanupForConnection('mobile-socket')
    const afterDisconnect = h.frames.length
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.frames).toHaveLength(afterDisconnect)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    const second = h.open('mobile-2')
    await second.renew()
    await vi.advanceTimersByTimeAsync(121_000)
    expect(h.cleanups.size).toBe(0)
    const starts = mocks.getPRForBranchOutcomeMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(starts)
  })

  it('does not let remounts or unchanged renewals bypass shared error backoff, and retains last known data', async () => {
    const h = await harness()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    h.cache = {
      pr: {
        [h.candidate.cacheKey]: { data: makePR(), fetchedAt: -100_000, fetchedHeadOid: 'head-sha' }
      },
      issue: {}
    }
    const first = h.open()
    await first.renew()
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames).at(-1)).toMatchObject({
      review: { number: 12 },
      fetchedAt: -100_000,
      stale: true,
      error: 'offline'
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const second = h.open('mobile-2')
    await second.renew()
    await first.renew()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    first.close()
    second.close()
  })

  it('fences old branch results, release during lookup, and overlapping renewals', async () => {
    const h = await harness()
    let resolveLookup: (value: unknown) => void = () => {}
    mocks.getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve
        })
    )
    const first = h.open()
    await first.renew()
    await vi.advanceTimersByTimeAsync(0)
    h.candidate = {
      ...h.candidate,
      branch: 'new-branch',
      cacheKey: '/repo::new-branch',
      currentHeadOid: 'new-head'
    }
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    await first.renew()
    resolveLookup({ kind: 'found', pr: makePR(), fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.cache.pr['/repo::feature/test']).toBeUndefined()
    expect(
      snapshots(h.frames)
        .filter((frame) => frame.branch === 'new-branch')
        .every((frame) => frame.review === null)
    ).toBe(true)
    let releasePrepare: (value: WorkspaceReviewTarget) => void = () => {}
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePrepare = resolve
        })
    )
    const late = first.renew()
    first.close()
    const count = h.frames.length
    releasePrepare({ worktreeId: 'wt-1', branch: 'old', candidate: h.candidate })
    expect(await late).toBe(false)
    expect(h.frames).toHaveLength(count)
  })

  it.each(['merged', 'no-pr'] as const)('uses the shared settled %s cadence', async (state) => {
    const h = await harness()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () =>
      state === 'merged'
        ? {
            kind: 'found',
            pr: makePR({ state: 'merged', checksStatus: 'success' }),
            fetchedAt: Date.now()
          }
        : { kind: 'no-pr', fetchedAt: Date.now() }
    )
    const first = h.open()
    await first.renew()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50_000)
    await first.renew()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(state === 'merged' ? 1 : 2)
    first.close()
  })

  it('admits a foreground mobile workspace ahead of desktop list backlog without per-renewal starts', async () => {
    const h = await harness()
    mocks.getAllWebContentsMock.mockReturnValue([{ id: 1, isDestroyed: () => false }])
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    const backlog = Array.from({ length: 40 }, (_, index) => ({
      ...h.candidate,
      branch: `other-${index}`,
      cacheKey: `/repo::other-${index}`,
      worktreeId: `other-${index}`,
      isSelected: false
    }))
    h.coordinator.reportVisiblePRRefreshCandidates(backlog, 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    const first = h.open()
    await first.renew()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getPRForBranchOutcomeMock.mock.calls[1]?.[1]).toBe('feature/test')
    for (let repeat = 0; repeat < 5; repeat += 1) {
      await first.renew()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(
      mocks.getPRForBranchOutcomeMock.mock.calls.filter(([, branch]) => branch === 'feature/test')
    ).toHaveLength(1)
    first.close()
    h.coordinator.clearVisiblePRRefreshWindow(1)
  })

  it('honors an explicit PR suppression in a warm cache', async () => {
    const h = await harness()
    h.cache = {
      pr: {
        [h.candidate.cacheKey]: {
          data: makePR(),
          fetchedAt: Date.now(),
          fetchedHeadOid: 'head-sha'
        }
      },
      issue: {}
    }
    const target = await h.prepare()
    h.prepare.mockResolvedValue({ ...target, linkedPR: null, suppressedGitHubPR: 12 })
    const first = h.open()
    await first.renew()
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: null, fetchedAt: 1000 })
    first.close()
  })

  it('rejects an old PR result after relinking the same branch and HEAD', async () => {
    const h = await harness()
    h.candidate = { ...h.candidate, linkedPRNumber: 12 }
    let finishOld: (value: unknown) => void = () => {}
    mocks.getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const first = h.open()
    await first.renew()
    await vi.advanceTimersByTimeAsync(0)
    h.candidate = { ...h.candidate, linkedPRNumber: 13 }
    await first.renew()
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ number: 13 }),
      fetchedAt: Date.now()
    }))
    finishOld({ kind: 'found', pr: makePR({ number: 12 }), fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots(h.frames).filter((frame) => frame.review?.number === 12)).toHaveLength(0)
    expect(h.cache.pr[h.candidate.cacheKey]?.data?.number).toBe(13)
    first.close()
  })

  it('isolates a failed mobile sink from desktop completion and releases its interest', async () => {
    const h = await harness()
    mocks.getAllWebContentsMock.mockReturnValue([{ id: 1, isDestroyed: () => false }])
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR(),
      fetchedAt: Date.now()
    }))
    h.coordinator.subscribePRRefreshEvents(() => {
      throw new Error('dead stream')
    })
    const first = h.open('mobile-1', undefined, () => {
      throw new Error('socket closed')
    })
    await first.renew()
    h.coordinator.reportVisiblePRRefreshCandidates([h.candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      mocks.sendToTrustedUIRendererMock.mock.calls.some(
        ([, event]) => event.outcome?.kind === 'found'
      )
    ).toBe(true)
    expect(h.cleanups.size).toBe(0)
    h.coordinator.clearVisiblePRRefreshWindow(1)
  })
})
