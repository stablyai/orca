import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const WORKTREES = 20
const LINKED_PR_KEY = 'local::runtime:host::/repo::pr::42'

function visibleCandidates(): GitHubPRRefreshCandidate[] {
  return Array.from({ length: WORKTREES }, (_, i) =>
    makeCandidate({
      cacheKey: `/repo::feature/${i}`,
      branch: `feature/${i}`,
      worktreeId: `wt-${i}`,
      cachedFetchedAt: null
    })
  )
}

describe('pr-refresh queue growth bounds', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found' as const,
      pr: makePR({ checksStatus: 'pending' as const }),
      fetchedAt: Date.now()
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the queue bounded across repeated visible reports and background pauses', async () => {
    const { reportVisiblePRRefreshCandidates, _getPRRefreshQueueSizeForTests } =
      await import('./pr-refresh-coordinator')

    for (let cycle = 0; cycle < 200; cycle += 1) {
      reportVisiblePRRefreshCandidates(visibleCandidates(), cycle + 1, 1)
      await vi.advanceTimersByTimeAsync(30_000)
    }
    // 200 report cycles * 20 candidates = 4000 enqueues; the queue coalesces to one entry per key.
    expect(_getPRRefreshQueueSizeForTests()).toBeLessThanOrEqual(WORKTREES)
  })

  it('keeps visibility windows and error backoff bounded when renderer windows churn', async () => {
    const {
      reportVisiblePRRefreshCandidates,
      _getVisiblePRRefreshWindowCountForTests,
      _getPRRefreshErrorBackoffCountForTests
    } = await import('./pr-refresh-coordinator')

    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error' as const,
      errorType: 'unknown' as const,
      message: 'boom',
      fetchedAt: Date.now()
    }))

    for (let windowId = 1; windowId <= 300; windowId += 1) {
      coordinatorMocks.getAllWebContentsMock.mockReturnValue([
        { id: windowId, isDestroyed: () => false, send: coordinatorMocks.sendMock }
      ])
      reportVisiblePRRefreshCandidates(visibleCandidates(), 1, windowId)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(_getVisiblePRRefreshWindowCountForTests()).toBeLessThanOrEqual(1)
    expect(_getPRRefreshErrorBackoffCountForTests()).toBeLessThanOrEqual(WORKTREES)
  })

  it("drops a worktree's stale branch aliases instead of fanning out to its whole history", async () => {
    const {
      reportVisiblePRRefreshCandidates,
      _getPRRefreshAliasCountForTests,
      _getPRRefreshQueueSizeForTests
    } = await import('./pr-refresh-coordinator')

    // A linked-PR refreshKey ignores the branch, so one entry survives every
    // branch switch, and each switch used to add an alias that only the next
    // drain could shed — so the fan-out tracked branch churn instead of the one
    // live branch. (Draining between switches caps the unfixed count in the low
    // single digits here; the parked-entry case below is where it really piles up.)
    for (let i = 0; i < 300; i += 1) {
      reportVisiblePRRefreshCandidates(
        [
          makeCandidate({
            cacheKey: `/repo::churn/${i}`,
            branch: `churn/${i}`,
            worktreeId: 'wt-churn',
            linkedPRNumber: 42,
            cachedFetchedAt: null
          })
        ],
        i + 1,
        1
      )
      await vi.advanceTimersByTimeAsync(20_000)
    }

    expect(_getPRRefreshQueueSizeForTests()).toBe(1)
    expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
    const broadcastAliasCounts = coordinatorMocks.sendMock.mock.calls
      .filter((call) => call[0] === 'gh:prRefreshEvent')
      .map((call) => (call[1] as { aliases: unknown[] }).aliases.length)
    expect(Math.max(...broadcastAliasCounts)).toBe(1)
  })

  it('keeps the newer alias when a branch switch lands mid-request', async () => {
    const { reportVisiblePRRefreshCandidates, _getPRRefreshAliasCountForTests } =
      await import('./pr-refresh-coordinator')

    const churnCandidate = (index: number): GitHubPRRefreshCandidate =>
      makeCandidate({
        cacheKey: `/repo::churn/${index}`,
        branch: `churn/${index}`,
        worktreeId: 'wt-churn',
        linkedPRNumber: 42,
        cachedFetchedAt: null
      })

    let switched = false
    getPRForBranchOutcomeMock.mockImplementation(async () => {
      if (!switched) {
        switched = true
        // The entry is already out of the queue here, so this re-enqueue creates the
        // entry the in-flight request's stale follow-up aliases merge back into.
        reportVisiblePRRefreshCandidates([churnCandidate(2)], 2, 1)
      }
      return {
        kind: 'found' as const,
        pr: makePR({ checksStatus: 'pending' as const }),
        fetchedAt: Date.now()
      }
    })

    reportVisiblePRRefreshCandidates([churnCandidate(1)], 1, 1)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
    const broadcasts = coordinatorMocks.sendMock.mock.calls.filter(
      (call) => call[0] === 'gh:prRefreshEvent'
    ) as [string, { aliases: { cacheKey: string }[] }][]
    const lastBroadcast = broadcasts.at(-1)
    expect(lastBroadcast?.[1].aliases.map((alias) => alias.cacheKey)).toEqual(['/repo::churn/2'])
  })

  it('does not restore an older candidate over a fresher branch switch', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const first = makeCandidate({
      cacheKey: '/repo::churn/1',
      branch: 'churn/1',
      worktreeId: 'wt-churn',
      linkedPRNumber: 42,
      cachedFetchedAt: null
    })
    const switched = makeCandidate({
      cacheKey: '/repo::churn/2',
      branch: 'churn/2',
      worktreeId: 'wt-churn',
      linkedPRNumber: 42,
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'open',
      cachedChecksStatus: 'success'
    })

    let didSwitch = false
    getPRForBranchOutcomeMock.mockImplementation(async () => {
      if (!didSwitch) {
        didSwitch = true
        reportVisiblePRRefreshCandidates([switched], 2, 1)
      }
      return {
        kind: 'found' as const,
        pr: makePR({ checksStatus: 'pending' as const }),
        fetchedAt: Date.now()
      }
    })

    reportVisiblePRRefreshCandidates([first], 1, 1)
    await vi.advanceTimersByTimeAsync(100_000)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual(['churn/1'])
    await vi.advanceTimersByTimeAsync(500_001)
    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual([
      'churn/1',
      'churn/2'
    ])
  })

  it('keeps distinct worktrees sharing one linked-PR key in the fan-out', async () => {
    const { enqueuePRRefresh, _getPRRefreshAliasCountForTests } =
      await import('./pr-refresh-coordinator')

    for (let i = 0; i < 4; i += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::shared/${i}`,
          branch: `shared/${i}`,
          worktreeId: `wt-${i}`,
          linkedPRNumber: 42,
          cachedFetchedAt: Date.now() + 60_000
        }),
        'visible',
        40,
        1
      )
    }
    expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(4)
  })

  it('coalesces branch churn into one alias while the entry waits to drain', async () => {
    const { enqueuePRRefresh, _getPRRefreshAliasCountForTests, _getPRRefreshQueueSizeForTests } =
      await import('./pr-refresh-coordinator')

    // No timer advance: the entry stays queued, so every enqueue lands on the same
    // alias map and the coalescing bound is what keeps it from growing.
    for (let i = 0; i < 200; i += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::churn/${i}`,
          branch: `churn/${i}`,
          worktreeId: 'wt-churn',
          linkedPRNumber: 42,
          cachedFetchedAt: null
        }),
        'swr',
        10,
        1
      )
    }
    expect(_getPRRefreshQueueSizeForTests()).toBe(1)
    expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    const outcomeAliases = coordinatorMocks.sendMock.mock.calls
      .filter((call) => call[0] === 'gh:prRefreshEvent')
      .map((call) => (call[1] as { aliases: { cacheKey: string }[] }).aliases)
    expect(outcomeAliases.every((aliases) => aliases.length === 1)).toBe(true)
    expect(outcomeAliases.at(-1)?.[0].cacheKey).toBe('/repo::churn/199')
  })

  it('keeps a manually refreshed worktree to one alias across branch churn', async () => {
    const { reportVisiblePRRefreshCandidates, refreshPRNow, _getPRRefreshAliasCountForTests } =
      await import('./pr-refresh-coordinator')

    const churnCandidate = (index: number): GitHubPRRefreshCandidate =>
      makeCandidate({
        cacheKey: `/repo::churn/${index}`,
        branch: `churn/${index}`,
        worktreeId: 'wt-churn',
        linkedPRNumber: 42,
        cachedFetchedAt: null
      })

    // A manual refresh merges its alias into its own copy of the entry's map and
    // writes that map back, so the coalescing bound has to hold on re-entry too.
    reportVisiblePRRefreshCandidates([churnCandidate(0)], 1, 1)
    await vi.advanceTimersByTimeAsync(1_000)
    for (let i = 1; i <= 30; i += 1) {
      await refreshPRNow(churnCandidate(i))
      await vi.advanceTimersByTimeAsync(1)
    }

    expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
  })
})
