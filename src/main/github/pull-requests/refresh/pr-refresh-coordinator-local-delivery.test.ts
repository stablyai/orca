import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type * as BranchLookup from '../../client/lookup/pr-for-branch-outcome'
import type {
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'
import {
  createTestStore,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from '../../../../renderer/src/store/github/github-slice-test-harness'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../../../../renderer/src/store/github/requests/request-coordination'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})
// Only the provider is faked: the lookup, its exact cache, the queue and the renderer's handling of
// the refresh events it receives are the real ones.
const provider = vi.hoisted(() => ({ resolve: vi.fn(), gate: vi.fn() }))
vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: provider.gate
}))
vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: provider.resolve
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))

const target = makeCandidate({
  branch: 'target',
  cacheKey: '/repo::target',
  worktreeId: 'wt-target',
  currentHeadOid: 'head-sha'
})
let renderer: ReturnType<typeof createTestStore>

beforeEach(() => {
  moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  vi.setSystemTime(1_000)
  provider.resolve.mockReset()
  provider.gate.mockReset().mockResolvedValue(null)
  resetRemoteRuntimeMocks()
  mockApi.gh.refreshPRNow.mockReset()
  mockApi.hostedReview.forBranch.mockResolvedValue(null)
  _clearGitHubPRRefreshStartedEntriesForTest()
  renderer = createTestStore()
  renderer.setState({
    repos: [
      { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: {
      'repo-1': [
        makePRRefreshWorktree({
          id: 'wt-target',
          branch: 'target',
          head: 'head-sha',
          path: '/repo'
        })
      ]
    }
  })
  coordinatorMocks.sendToTrustedUIRendererMock.mockImplementation((_channel, event) =>
    renderer.getState().applyGitHubPRRefreshEvent(event)
  )
})
// Transforming the coordinator's module graph is the slow first step on a loaded machine: do it
// once under the hook limit, so each test still imports its own fresh instance, quickly.
beforeAll(async () => {
  await import('./pr-refresh-coordinator')
})
afterEach(() => {
  // A body that failed must not leave its timers to run on the next test's clock.
  vi.clearAllTimers()
  vi.useRealTimers()
})

function found(title: string): PRRefreshOutcome {
  return { kind: 'found', fetchedAt: Date.now(), pr: makePR({ title, checksStatus: 'pending' }) }
}

const reads = () => provider.resolve.mock.calls.length
const shown = () => renderer.getState().prCache['/repo::target']?.data?.title
const state = () => renderer.getState().prRefreshStates['/repo::target']?.status

// 256 other exact results, each held: the exact cache has no room for this request's.
async function fillExactCache(lookup: typeof BranchLookup) {
  provider.resolve.mockImplementation(async () => found('other'))
  const holds: (() => void)[] = []
  for (let other = 0; other < 256; other += 1) {
    const prepared = await lookup.preparePRBranchRead('/repo', `other-${other}`, null, null, null, {
      currentHeadOid: 'head-sha'
    })
    await prepared.read()
    holds.push(prepared.hold())
  }
  provider.resolve.mockReset()
  return holds
}

// A secondary rate limit as gh reports it, which the real parser turns into a 300 s Retry-After.
const secondaryLimit = () =>
  Object.assign(new Error('gh: HTTP 429'), {
    stderr: 'HTTP 429: You have exceeded a secondary rate limit.\nRetry-After: 300'
  })

async function load() {
  const coordinator = await import('./pr-refresh-coordinator')
  const lookup = await import('../../client/lookup/pr-for-branch-outcome')
  const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
  // A paired client's foreground read of the same request, through the runtime's direct path; the
  // exact cache has room for its result unless the test fills it. A forced one replaces a read of
  // the same request already running.
  const directRead = async (forced = false) => {
    const prepared = await lookup.preparePRBranchRead(
      '/repo',
      'target',
      null,
      null,
      null,
      hostedReviewOptionArgs(target, 'active', forced ? { userRefresh: true } : {})[0] ?? {}
    )
    return coordinator.runHostedPRRead(target, prepared)
  }
  // The row's own read starts at 1 s and is held; the paired client's read runs at 5 s.
  const replacedAt5s = async (newer: () => PRRefreshOutcome) => {
    const own = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => own.promise)
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    await vi.advanceTimersByTimeAsync(4_000)
    provider.resolve.mockImplementationOnce(async () => newer())
    await directRead()
    await vi.advanceTimersByTimeAsync(1_000)
    return own
  }
  return { coordinator, lookup, directRead, replacedAt5s }
}

it.each([
  ['no PR', { kind: 'no-pr', fetchedAt: 6_000 }],
  ['an older PR', { kind: 'found', fetchedAt: 6_000, pr: makePR({ title: 'older' }) }]
] as const)(
  'an own read a newer read replaced, ending with %s, shows the newer data and keeps its plan',
  async (_label, late) => {
    const { replacedAt5s } = await load()
    const own = await replacedAt5s(() => found('newer'))
    own.resolve(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown()).toBe('newer')
    expect(state()).not.toBe('in-flight')

    // The newer read's ordinary follow-up, two minutes after it.
    provider.resolve.mockImplementation(async () => found('changed'))
    await vi.advanceTimersByTimeAsync(124_999 - Date.now())
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads()).toBe(3)
    expect(shown()).toBe('changed')
  }
)

it('a newer read’s failure stands over an older success, and keeps its own retry', async () => {
  const { replacedAt5s } = await load()
  const own = await replacedAt5s(() => ({
    kind: 'upstream-error',
    errorType: 'network',
    message: 'offline',
    fetchedAt: Date.now()
  }))
  own.resolve({ kind: 'found', fetchedAt: 6_000, pr: makePR({ title: 'older' }) })
  await vi.advanceTimersByTimeAsync(0)
  expect(shown()).toBeUndefined()
  expect(state()).toBe('error')

  provider.resolve.mockImplementation(async () => found('changed'))
  await vi.advanceTimersByTimeAsync(124_999 - Date.now())
  expect(reads()).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(reads()).toBe(3)
  expect(shown()).toBe('changed')
})

it('a refresh that joined the replaced read shows the newer data, once, with no read of its own', async () => {
  const { coordinator, directRead } = await load()
  const observed: string[] = []
  coordinator.addPRRefreshOutcomeObserver((_candidate, outcome) => observed.push(outcome.kind))
  const own = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => own.promise)
  coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
  await vi.advanceTimersByTimeAsync(1_000)
  // A refresh of the same row joins the read already running instead of starting another.
  const joined = coordinator.refreshPRNow(target, 'visible')
  await vi.advanceTimersByTimeAsync(3_000)
  expect(reads()).toBe(1)
  provider.resolve.mockImplementationOnce(async () => found('newer'))
  await directRead()
  own.resolve({ kind: 'found', fetchedAt: Date.now(), pr: makePR({ title: 'older' }) })
  expect(await joined).toMatchObject({ pr: { title: 'newer' } })
  await vi.advanceTimersByTimeAsync(0)
  // Only the paired client's read was observed; the replaced read and its join publish nothing.
  expect(reads()).toBe(2)
  expect(observed).toEqual(['found'])
  expect(shown()).toBe('newer')
  expect(state()).not.toBe('in-flight')
})

it.each(['no newer request', 'a newer request of the row'] as const)(
  'a row read replaced by a still-running newer read ends its own loading with %s, and the newer data follows',
  async (successor) => {
    const { coordinator, directRead } = await load()
    const own = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => own.promise)
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    await vi.advanceTimersByTimeAsync(4_000)
    const newer = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => newer.promise)
    const paired = directRead()
    await vi.advanceTimersByTimeAsync(0)
    // A refresh of the row joins the newer read; it is the row's request from now on.
    const refresh =
      successor === 'a newer request of the row' ? coordinator.refreshPRNow(target, 'manual') : null
    await vi.advanceTimersByTimeAsync(1_000)
    own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    // The replaced no-PR never lands; only a request the row no longer has is left loading.
    expect(shown()).toBeUndefined()
    expect(state()).toBe(refresh ? 'in-flight' : 'skipped')

    newer.resolve(found('newer'))
    await paired
    await refresh
    await vi.advanceTimersByTimeAsync(0)
    if (!refresh) {
      // Its kept demand runs once the request's own 10 s spacing allows, from the exact cache.
      await vi.advanceTimersByTimeAsync(10_999 - Date.now())
      expect(shown()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(shown()).toBe('newer')
    expect(state()).not.toBe('in-flight')
    expect(reads()).toBe(2)
  }
)

it('a user’s refresh a newer read replaced answers without data, and the newer data arrives queued', async () => {
  const { coordinator, directRead } = await load()
  // The renderer's real refresh action, over the main handler's call.
  mockApi.gh.refreshPRNow.mockImplementation(
    (args: { candidate: typeof target; reason?: GitHubPRRefreshReason; userRefresh?: boolean }) =>
      coordinator.refreshPRNow(args.candidate, args.reason, { userRefresh: args.userRefresh })
  )
  const cacheKey = 'repo-1::target'
  const shownByAction = () => renderer.getState().prCache[cacheKey]?.data?.title
  renderer.setState({
    prCache: { [cacheKey]: { data: makePR({ title: 'shown' }), fetchedAt: 500 } }
  })
  coordinator.reportVisiblePRRefreshCandidates(
    [
      {
        ...target,
        cacheKey,
        repoId: 'repo-1',
        cachedFetchedAt: 500,
        cachedHeadOid: 'head-sha',
        cachedHasPR: true,
        cachedPRState: 'open',
        cachedChecksStatus: 'pending'
      }
    ],
    1,
    1
  )
  await vi.advanceTimersByTimeAsync(1_000)
  expect(reads()).toBe(0)
  const own = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => own.promise)
  const action = renderer.getState().fetchPRForBranch('/repo', 'target', {
    force: true,
    repoId: 'repo-1',
    worktreeId: 'wt-target'
  })
  await vi.advanceTimersByTimeAsync(1_000)
  const newer = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => newer.promise)
  const paired = directRead(true)
  await vi.advanceTimersByTimeAsync(1_000)
  own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
  // The action's reply carries no data: the shown PR stays, and the refresh no longer loads.
  expect((await action)?.title).toBe('shown')
  expect(shownByAction()).toBe('shown')
  expect(renderer.getState().prRefreshStates[cacheKey]?.status).not.toBe('in-flight')

  newer.resolve(found('newer'))
  await paired
  // The refresh's own demand comes back after its 10 s spacing and takes the newer result.
  await vi.advanceTimersByTimeAsync(12_000 - Date.now())
  expect(shownByAction()).toBe('newer')
  expect(reads()).toBe(2)
})

it('a legacy client’s own finished read answers it at once, with no other read, at full capacity', async () => {
  const { coordinator, lookup, directRead } = await load()
  // 256 other exact results, each held: the exact cache has no room for this request's.
  const holds = await fillExactCache(lookup)
  const otherReads = reads()
  const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
  const snapshot = async (opted: boolean) =>
    coordinator.runHostedPRSnapshot(
      target,
      await lookup.preparePRBranchRead(
        '/repo',
        'target',
        null,
        null,
        null,
        hostedReviewOptionArgs(target, 'swr')[0] ?? {}
      ),
      Date.now() + 25_000,
      undefined,
      opted
    )
  const own = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => own.promise)
  const legacy = snapshot(false)
  await vi.advanceTimersByTimeAsync(0)
  // A second older client asks while that read is still running, before any newer read: it waits
  // on the running read instead of starting one.
  const sibling = snapshot(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(reads() - otherReads).toBe(1)
  const newer = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => newer.promise)
  const paired = directRead(true)
  await vi.advanceTimersByTimeAsync(0)
  own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
  // Both are answered with their own read's result while the newer read still runs; no third read.
  expect(await legacy).toMatchObject({ kind: 'no-pr' })
  expect(await sibling).toMatchObject({ kind: 'no-pr' })
  expect(await snapshot(true)).toMatchObject({ revalidation: { invalidated: true } })
  expect(reads() - otherReads).toBe(2)
  newer.resolve(found('newer'))
  await paired
  holds.forEach((release) => release())
})

it('a read whose scope changed while it ran settles nothing and is not observed', async () => {
  const { coordinator, lookup, directRead } = await load()
  const { bumpScopeGeneration, hostedReviewRepoScope } =
    await import('../../../source-control/hosted-review-scope-generations')
  const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
  const observed: string[] = []
  coordinator.addPRRefreshOutcomeObserver((_candidate, outcome) => observed.push(outcome.kind))
  const own = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => own.promise)
  const opted = coordinator.runHostedPRSnapshot(
    target,
    await lookup.preparePRBranchRead(
      '/repo',
      'target',
      null,
      null,
      null,
      hostedReviewOptionArgs(target, 'swr')[0] ?? {}
    ),
    Date.now() + 25_000,
    undefined,
    true
  )
  await vi.advanceTimersByTimeAsync(0)
  // A review created meanwhile invalidates what the repo's reads saw.
  bumpScopeGeneration(hostedReviewRepoScope('/repo', 'local'))
  own.resolve({
    kind: 'upstream-error',
    errorType: 'rate_limited',
    message: 'slow down',
    fetchedAt: Date.now(),
    retryDisabledUntil: Date.now() + 300_000
  })
  expect(await opted).toMatchObject({ revalidation: { invalidated: true } })
  expect(observed).toEqual([])
  expect(coordinator._getPRRefreshErrorBackoffCountForTests()).toBe(0)

  // A read in the new scope settles and is observed as usual.
  provider.resolve.mockImplementationOnce(async () => found('current'))
  await directRead()
  expect(observed).toEqual(['found'])
})

it.each([
  ['after its kept demand left the queue', 12_000, false, false],
  ['before its kept demand left the queue', 9_000, false, false],
  ['after its kept demand left the queue, with no room to keep it', 12_000, true, false],
  ['after its kept demand left the queue, then Reduced at 13 s', 12_000, false, true],
  ['with no room to keep it, then Reduced at 13 s', 12_000, true, true]
] as const)(
  'a newer read’s rate limit that lands %s holds the row until its retry, then the row recovers',
  async (_label, failsAt, full, reduced) => {
    const policy = await import('../../../../shared/review-refresh-policy')
    const { coordinator, lookup, directRead } = await load()
    const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
    const holds = full ? await fillExactCache(lookup) : []
    const observed: string[] = []
    coordinator.addPRRefreshOutcomeObserver((_candidate, outcome) => observed.push(outcome.kind))
    const own = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => own.promise)
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    await vi.advanceTimersByTimeAsync(4_000)
    const newer = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => newer.promise)
    const paired = directRead()
    await vi.advanceTimersByTimeAsync(1_000)
    // The row's own read is replaced at 6 s; its demand comes back at 11 s, after its spacing.
    own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    expect(state()).toBe('skipped')
    const quota = Promise.withResolvers<number | null>()
    if (failsAt === 12_000) {
      // That demand is taken at 11 s and waits for quota while the newer read fails.
      const gateChecks = provider.gate.mock.calls.length
      provider.gate.mockReturnValueOnce(quota.promise)
      await vi.advanceTimersByTimeAsync(11_000 - Date.now())
      expect(provider.gate.mock.calls.length).toBe(gateChecks + 1)
      expect(provider.gate.mock.calls.at(-1)).toEqual([
        expect.objectContaining({ branch: 'target', currentHeadOid: 'head-sha' }),
        true
      ])
    }
    await vi.advanceTimersByTimeAsync(failsAt - Date.now())
    newer.reject(secondaryLimit())
    await paired
    if (reduced) {
      // The host moves to Reduced before the quota answer: the retry follows its plan from the
      // failure (12 s + 600 s), the reported limit still ends at 312 s.
      await vi.advanceTimersByTimeAsync(13_000 - Date.now())
      policy.setPRAutoRefreshCadence('reduced')
      coordinator.retimePRRefreshesForCadence()
      await vi.advanceTimersByTimeAsync(14_000 - Date.now())
    }
    quota.resolve(null)
    await vi.advanceTimersByTimeAsync(0)

    // No read starts before the retry; the row shows the scheduled failure and the host's limit.
    const limitedUntil = failsAt + 300_000
    const retryAt = reduced ? failsAt + 600_000 : limitedUntil
    expect(observed).toEqual(['upstream-error'])
    expect(coordinator._getPRRefreshErrorBackoffCountForTests()).toBe(1)
    if (failsAt === 12_000) {
      expect(renderer.getState().prRefreshStates['/repo::target']).toMatchObject({
        status: 'error',
        nextAutoRetryAt: retryAt,
        retryDisabledUntil: limitedUntil
      })
    }
    if (!full) {
      const prepared = await lookup.preparePRBranchRead(
        '/repo',
        'target',
        null,
        null,
        null,
        hostedReviewOptionArgs(target, 'visible')[0] ?? {}
      )
      expect(prepared.cached()?.outcome).toMatchObject({
        kind: 'upstream-error',
        fetchedAt: failsAt,
        nextAutoRetryAt: retryAt,
        retryDisabledUntil: limitedUntil
      })
    }
    provider.resolve.mockImplementation(async () => found('recovered'))
    await vi.advanceTimersByTimeAsync(retryAt - 1 - Date.now())
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads()).toBe(3)
    expect(shown()).toBe('recovered')
    expect(observed).toEqual(['upstream-error', 'found'])
    expect(coordinator._getPRRefreshErrorBackoffCountForTests()).toBe(0)
    holds.forEach((release) => release())
  }
)

it('a return a newer read replaced waits out that read’s rate limit, then reads', async () => {
  const { coordinator, directRead } = await load()
  const shownTarget = {
    ...target,
    cachedFetchedAt: 500,
    cachedHeadOid: 'head-sha',
    cachedHasPR: true,
    cachedPRState: 'open' as const,
    cachedChecksStatus: 'pending' as const
  }
  coordinator.reportVisiblePRRefreshCandidates([shownTarget], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(reads()).toBe(0)
  // The user's return (an active read) is replaced by a newer read; it stays owed as a return.
  const own = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => own.promise)
  const action = coordinator.refreshPRNow(shownTarget, 'active')
  await vi.advanceTimersByTimeAsync(4_000)
  const newer = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => newer.promise)
  const paired = directRead(true)
  await vi.advanceTimersByTimeAsync(1_000)
  own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
  expect(await action).toMatchObject({ revalidation: { invalidated: true } })
  // The newer read fails at 7 s with a 300 s Retry-After; the owed return is held until then.
  await vi.advanceTimersByTimeAsync(1_000)
  newer.reject(secondaryLimit())
  await paired
  provider.resolve.mockImplementation(async () => found('recovered'))
  await vi.advanceTimersByTimeAsync(306_999 - Date.now())
  expect(reads()).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(reads()).toBe(3)
  expect(shown()).toBe('recovered')
})

it.each(['queued', 'the refresh action'] as const)(
  'under Off, an active read a newer read replaced (%s) still shows that newer read, with no read of its own',
  async (route) => {
    const policy = await import('../../../../shared/review-refresh-policy')
    policy.setPRAutoRefreshCadence('off')
    const { coordinator, directRead } = await load()
    const cacheKey = 'repo-1::target'
    const row = {
      ...target,
      cacheKey,
      repoId: 'repo-1',
      cachedFetchedAt: 500,
      cachedHeadOid: 'head-sha',
      cachedHasPR: true,
      cachedPRState: 'open' as const,
      cachedChecksStatus: 'pending' as const
    }
    const shownByRow = () => renderer.getState().prCache[cacheKey]?.data?.title
    renderer.setState({
      prCache: { [cacheKey]: { data: makePR({ title: 'shown' }), fetchedAt: 500 } }
    })
    mockApi.gh.refreshPRNow.mockImplementation(
      (args: { candidate: typeof row; reason?: GitHubPRRefreshReason; userRefresh?: boolean }) =>
        coordinator.refreshPRNow(args.candidate, args.reason, { userRefresh: args.userRefresh })
    )
    coordinator.reportVisiblePRRefreshCandidates([row], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(0)
    // The user opens the checks tab (or refreshes its conflicts): an active read at 1 s.
    const own = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => own.promise)
    let action: Promise<PRInfo | null> | null = null
    if (route === 'queued') {
      coordinator.enqueuePRRefresh(row, 'active', 80, 1)
    } else {
      action = renderer.getState().fetchPRForBranch('/repo', 'target', {
        force: true,
        reason: 'active',
        repoId: 'repo-1',
        worktreeId: 'wt-target'
      })
    }
    await vi.advanceTimersByTimeAsync(4_000)
    expect(reads()).toBe(1)
    const newer = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => newer.promise)
    const paired = directRead(true)
    await vi.advanceTimersByTimeAsync(1_000)
    own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    if (action) {
      expect((await action)?.title).toBe('shown')
    }
    expect(shownByRow()).toBe('shown')
    expect(renderer.getState().prRefreshStates[cacheKey]?.status).not.toBe('in-flight')
    await vi.advanceTimersByTimeAsync(1_000)
    newer.resolve(found('newer'))
    await paired
    // The owed return runs once its request's 10 s spacing allows and takes the newer result.
    await vi.advanceTimersByTimeAsync(10_999 - Date.now())
    expect(shownByRow()).toBe('shown')
    await vi.advanceTimersByTimeAsync(1)
    expect(shownByRow()).toBe('newer')
    // The newer read's own observation time, not the time it was shown.
    expect(renderer.getState().prCache[cacheKey]?.fetchedAt).toBe(7_000)
    expect(reads()).toBe(2)
    // Off still runs no timer for the row.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(reads()).toBe(2)
  }
)

it.each(['its last window', 'one of two windows showing it'] as const)(
  'a kept wake waiting for quota when %s closes starts no read after the newer read succeeded',
  async (closed) => {
    const { coordinator, directRead } = await load()
    const resources = await import('../../client/lookup/pr-branch-read-resources')
    coordinatorMocks.getAllWebContentsMock.mockReturnValue([
      { id: 1, isDestroyed: () => false },
      { id: 2, isDestroyed: () => false }
    ])
    const own = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => own.promise)
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    if (closed === 'one of two windows showing it') {
      coordinator.reportVisiblePRRefreshCandidates([target], 1, 2)
    }
    await vi.advanceTimersByTimeAsync(4_000)
    const newer = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => newer.promise)
    const paired = directRead()
    await vi.advanceTimersByTimeAsync(1_000)
    own.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(0)
    // The kept demand is taken at 11 s and waits for quota.
    const gateChecks = provider.gate.mock.calls.length
    const quota = Promise.withResolvers<number | null>()
    provider.gate.mockReturnValueOnce(quota.promise)
    await vi.advanceTimersByTimeAsync(11_000 - Date.now())
    expect(provider.gate.mock.calls.length).toBe(gateChecks + 1)
    // The newer read succeeds at 12 s; window 1 closes at 13 s; quota answers at 14 s.
    await vi.advanceTimersByTimeAsync(1_000)
    newer.resolve(found('newer'))
    await paired
    await vi.advanceTimersByTimeAsync(1_000)
    coordinator.clearVisiblePRRefreshWindow(1)
    await vi.advanceTimersByTimeAsync(1_000)
    quota.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(2)
    expect(provider.gate.mock.calls.length).toBe(gateChecks + 1)
    expect(coordinator._getPRRefreshErrorBackoffCountForTests()).toBe(0)
    expect(resources._prBranchReadResourceCountForTests()).toBe(0)
    provider.resolve.mockImplementation(async () => found('changed'))
    if (closed === 'its last window') {
      // No row wants it any more: nothing was queued again, and nothing reads later.
      expect(coordinator._getPRRefreshQueueSizeForTests()).toBe(0)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(reads()).toBe(2)
    } else {
      // Window 2 still shows the row: its ordinary follow-up reads two minutes after the newer read.
      await vi.advanceTimersByTimeAsync(131_999 - Date.now())
      expect(reads()).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(reads()).toBe(3)
    }
  }
)
