import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const LINKED_PR_KEY = 'local::runtime:host::/repo::pr::42'

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
        // Re-enqueue after dequeue so the older in-flight snapshot merges into a newer queued entry.
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
    await vi.advanceTimersByTimeAsync(119_999)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual(['churn/1'])
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual([
      'churn/1',
      'churn/2'
    ])
  })
})
