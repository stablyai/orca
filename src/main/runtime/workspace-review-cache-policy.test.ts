import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness, snapshots } from './workspace-review-subscription.test-fixture'
import { makePR } from '../github/pr-refresh-coordinator-test-harness'
import { aliasFromCandidate, sameAliasRequestIdentity } from '../github/pr-refresh-candidate-policy'

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
afterEach(() => vi.useRealTimers())

it.each(['head-sha', 'contained-head'])(
  'preserves a merged PR at %s on a branch miss',
  async (head) => {
    const h = await harness()
    h.candidate = { ...h.candidate, currentHeadOid: head }
    const cached = {
      data: makePR({
        state: 'merged',
        checksStatus: 'success',
        confirmedContainedHeadOid: 'contained-head'
      }),
      fetchedAt: -100_000
    }
    h.cache = { pr: { [h.candidate.cacheKey]: cached }, issue: {} }
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    const subscription = h.open()
    try {
      await subscription.renew()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.cache.pr[h.candidate.cacheKey]).toBe(cached)
      expect(snapshots(h.frames).at(-1)).toMatchObject({
        review: { state: 'merged' },
        stale: false
      })
      expect(mocks.getPRForBranchOutcomeMock.mock.calls[0]?.[4]).toBe(12)
      await vi.advanceTimersByTimeAsync(61_000)
      expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
    } finally {
      subscription.close()
    }
  }
)

it.each([undefined, 'contained-head', 'previous-fetch'])(
  'publishes contained merged heads as fresh without changing fetch provenance (%s)',
  async (fetchedHeadOid) => {
    const h = await harness()
    h.candidate = { ...h.candidate, currentHeadOid: 'contained-head' }
    const cached = {
      data: makePR({
        state: 'merged',
        checksStatus: 'success',
        confirmedContainedHeadOid: 'contained-head'
      }),
      fetchedAt: Date.now(),
      ...(fetchedHeadOid ? { fetchedHeadOid } : {})
    }
    h.cache = { pr: { [h.candidate.cacheKey]: cached }, issue: {} }
    const subscription = h.open()
    await subscription.renew()
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: { state: 'merged' }, stale: false })
    expect(h.cache.pr[h.candidate.cacheKey]).toBe(cached)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getPRForBranchOutcomeMock).not.toHaveBeenCalled()
    h.candidate = { ...h.candidate, currentHeadOid: 'changed-head' }
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    await subscription.renew()
    expect(snapshots(h.frames).at(-1)?.stale).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: null, stale: false })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: null, stale: false })
    subscription.close()
  }
)

it.each(['success', 'failure', 'pending'] as const)(
  'uses retained merged %s cadence immediately after a manual fallback miss',
  async (checksStatus) => {
    const h = await harness()
    const cached = {
      data: makePR({ state: 'merged', checksStatus }),
      fetchedAt: Date.now(),
      fetchedHeadOid: 'head-sha'
    }
    h.cache = { pr: { [h.candidate.cacheKey]: cached }, issue: {} }
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    const subscription = h.open()
    await subscription.renew()
    await vi.advanceTimersByTimeAsync(0)
    const target = await h.prepare()
    expect(target.candidate).not.toBeNull()
    if (!target.candidate) {
      throw new Error('Missing test candidate')
    }
    await h.coordinator.refreshPRNow(target.candidate)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
    expect(snapshots(h.frames).at(-1)).toMatchObject({
      review: { state: 'merged', checksStatus },
      stale: false
    })
    expect(h.cache.pr[h.candidate.cacheKey]).toBe(cached)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(
      checksStatus === 'pending' ? 2 : 1
    )
    await vi.advanceTimersByTimeAsync(49_000)
    expect(h.cleanups.size).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.cleanups.size).toBe(0)
    const starts = mocks.getPRForBranchOutcomeMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(starts)
  }
)

it.each([false, true])(
  'retains settled cadence across renewals with desktop reported last=%s',
  async (desktopLast) => {
    const h = await harness()
    mocks.getAllWebContentsMock.mockReturnValue([{ id: 1, isDestroyed: () => false }])
    h.candidate = { ...h.candidate, currentHeadOid: 'contained-head' }
    const cached = {
      data: makePR({
        state: 'merged',
        checksStatus: 'success',
        confirmedContainedHeadOid: 'contained-head'
      }),
      fetchedAt: Date.now()
    }
    h.cache = { pr: { [h.candidate.cacheKey]: cached }, issue: {} }
    const target = await h.prepare()
    if (!target.candidate) {
      throw new Error('Missing test candidate')
    }
    const candidate = target.candidate
    const desktop = () => h.coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    const subscription = h.open()
    if (!desktopLast) {
      desktop()
    }
    await subscription.renew()
    if (desktopLast) {
      desktop()
    }
    await vi.advanceTimersByTimeAsync(20_000)
    await h.coordinator.refreshPRNow(target.candidate)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.prepare).toHaveBeenCalledTimes(3)
    expect(snapshots(h.frames).at(-1)).toMatchObject({ review: { state: 'merged' }, stale: false })
    for (let renewal = 0; renewal < 3; renewal += 1) {
      await vi.advanceTimersByTimeAsync(50_000)
      await subscription.renew()
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
      expect(snapshots(h.frames).at(-1)?.stale).toBe(false)
    }
    expect(h.cache.pr[h.candidate.cacheKey]).toBe(cached)
    subscription.close()
    h.coordinator.clearVisiblePRRefreshWindow(1)
  }
)

it.each(['diverged', 'rejected', 'open', 'draft', 'no-head', 'linked'] as const)(
  'accepts an authoritative miss for %s cached PRs',
  async (condition) => {
    const h = await harness()
    h.candidate = {
      ...h.candidate,
      currentHeadOid:
        condition === 'no-head' ? null : condition === 'diverged' ? 'new-head' : 'head-sha',
      linkedPRNumber: condition === 'linked' ? 12 : null
    }
    const pr = makePR({
      state: condition === 'open' || condition === 'draft' ? condition : 'merged',
      checksStatus: 'success'
    })
    h.cache = { pr: { [h.candidate.cacheKey]: { data: pr, fetchedAt: -100_000 } }, issue: {} }
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now(),
      ...(condition === 'rejected' ? { rejectedPRUrls: [pr.url] } : {})
    }))
    const subscription = h.open()
    try {
      await subscription.renew()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.cache.pr[h.candidate.cacheKey]?.data).toBeNull()
    } finally {
      subscription.close()
    }
  }
)

it.each([false, true])(
  'delivers a shared local result with desktop reporting last=%s',
  async (desktopLast) => {
    const h = await harness()
    mocks.getAllWebContentsMock.mockReturnValue([{ id: 1, isDestroyed: () => false }])
    mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR(),
      fetchedAt: Date.now()
    }))
    const desktop = () =>
      h.coordinator.reportVisiblePRRefreshCandidates(
        [{ ...h.candidate, executionHostId: null }],
        1,
        1
      )
    const subscription = h.open()
    try {
      if (!desktopLast) {
        desktop()
      }
      await subscription.renew()
      if (desktopLast) {
        desktop()
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
      expect(snapshots(h.frames).at(-1)?.review?.number).toBe(12)
      const local = aliasFromCandidate(h.candidate)
      expect(sameAliasRequestIdentity(local, { ...local, executionHostId: 'runtime:other' })).toBe(
        false
      )
      expect(sameAliasRequestIdentity(local, { ...local, executionHostId: 'ssh:other' })).toBe(
        false
      )
    } finally {
      subscription.close()
      h.coordinator.clearVisiblePRRefreshWindow(1)
    }
  }
)

it('bounds host PR writes by age without changing the issue cache', async () => {
  const h = await harness()
  const issue = h.cache.issue
  h.cache = {
    pr: Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `other-repo::branch-${index}`,
        { data: null, fetchedAt: index - 500 }
      ])
    ),
    issue
  }
  const newestExisting = h.cache.pr['other-repo::branch-499']
  mocks.getPRForBranchOutcomeMock.mockResolvedValue({
    kind: 'found',
    pr: makePR(),
    fetchedAt: Date.now()
  })
  const subscription = h.open()
  try {
    await subscription.renew()
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(h.cache.pr)).toHaveLength(500)
    expect(h.cache.pr['other-repo::branch-0']).toBeUndefined()
    expect(h.cache.pr['other-repo::branch-499']).toBe(newestExisting)
    expect(h.cache.pr[h.candidate.cacheKey]?.data?.number).toBe(12)
    expect(h.cache.pr[h.candidate.cacheKey]?.fetchedHeadOid).toBe('head-sha')
    expect(h.cache.issue).toBe(issue)
    expect(snapshots(h.frames).at(-1)?.review?.number).toBe(12)
  } finally {
    subscription.close()
  }
})

it('publishes from the explicit executing host instead of the local repo bucket', async () => {
  const h = await harness()
  h.candidate = {
    ...h.candidate,
    executionHostId: 'runtime:server',
    cacheKey: 'runtime:server::repo-1::feature/test'
  }
  h.cache = {
    pr: {
      [h.candidate.cacheKey]: { data: makePR({ number: 13 }), fetchedAt: Date.now() },
      'repo-1::feature/test': { data: makePR({ number: 99 }), fetchedAt: Date.now() }
    },
    issue: {}
  }
  const subscription = h.open()
  await subscription.renew()
  expect(snapshots(h.frames)).toMatchObject([{ review: { number: 13 }, stale: false }])
  subscription.close()
})
