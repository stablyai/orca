import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const WATCHED = '/watched-repo'

function watchReads(): number {
  return getPRForBranchOutcomeMock.mock.calls.filter(([repoPath]) => repoPath === WATCHED).length
}

async function startWatch(): Promise<void> {
  const { schedulePRWatchRead, setPRWatchJobHooks } = await import('./pr-refresh-coordinator')
  setPRWatchJobHooks({ isWatched: () => true, readHeadChecks: async () => null })
  schedulePRWatchRead(
    { prKey: 'github.com/acme/watched#7' },
    makeCandidate({ repoPath: WATCHED, cacheKey: 'watch', linkedPRNumber: 7 }),
    Date.now()
  )
}

describe('pr-refresh watch jobs', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending' }),
      fetchedAt: Date.now()
    }))
  })

  it('re-reads an open PR every background interval with no window showing it', async () => {
    await startWatch()
    await vi.advanceTimersByTimeAsync(0)
    expect(watchReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(watchReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(watchReads()).toBe(2)
    await vi.advanceTimersByTimeAsync(10 * 120_000)
    expect(watchReads()).toBe(12)
  })

  it('stops once the PR is merged with its checks settled', async () => {
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ state: 'merged', checksStatus: 'success' }),
      fetchedAt: Date.now()
    }))
    await startWatch()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(watchReads()).toBe(1)
  })

  it('shares the background budget and still reads a watch while visible rows saturate it', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const visible = Array.from({ length: 30 }, (_, index) =>
      makeCandidate({
        repoPath: `/visible-${index}`,
        cacheKey: `visible-${index}`,
        worktreeId: `wt-${index}`
      })
    )
    reportVisiblePRRefreshCandidates(visible, 1, 1)
    await startWatch()
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000)
    // Twenty background starts per five minutes, watch reads included.
    expect(getPRForBranchOutcomeMock.mock.calls.length).toBeLessThanOrEqual(20)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // Aged past one interval, the watch outranks the visible rows that keep the budget full.
    expect(watchReads()).toBeGreaterThanOrEqual(2)
  })
})
