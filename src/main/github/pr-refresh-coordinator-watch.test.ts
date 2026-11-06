import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const WATCHED = '/watched-repo'
// Fake time starts here; reads stamp `fetchedAt` from the fake clock as it advances.
const START_AT = 1_000

function watchReads(): number {
  return getPRForBranchOutcomeMock.mock.calls.filter(([repoPath]) => repoPath === WATCHED).length
}

async function startWatch(): Promise<void> {
  const { schedulePRWatchRead, setPRWatchJobHooks } = await import('./pr-refresh-coordinator')
  setPRWatchJobHooks({ isWatched: () => true, readHeadChecks: async () => null })
  schedulePRWatchRead(
    { prKey: 'github.com/acme/watched#7' },
    makeCandidate({ repoPath: WATCHED, cacheKey: 'watch', linkedPRNumber: 7 }),
    START_AT
  )
}

describe('pr-refresh watch jobs', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    vi.setSystemTime(START_AT)
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
      pr: makePR({
        state: 'merged',
        checksStatus: 'success',
        checksReadComplete: true,
        checksFinal: true
      }),
      fetchedAt: Date.now()
    }))
    await startWatch()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(watchReads()).toBe(1)
  })

  it('keeps reading a merged PR whose failure sits beside a check still running', async () => {
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({
        state: 'merged',
        checksStatus: 'failure',
        checksReadComplete: true,
        checksFinal: false
      }),
      fetchedAt: Date.now()
    }))
    await startWatch()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(watchReads()).toBeGreaterThan(1)
  })

  it('gives saturating watches and visible rows each a share of the budget', async () => {
    const { reportVisiblePRRefreshCandidates, schedulePRWatchRead, setPRWatchJobHooks } =
      await import('./pr-refresh-coordinator')
    setPRWatchJobHooks({ isWatched: () => true, readHeadChecks: async () => null })
    for (let index = 0; index < 25; index++) {
      schedulePRWatchRead(
        { prKey: `github.com/acme/watched#${index}` },
        makeCandidate({ repoPath: `${WATCHED}-${index}`, cacheKey: `watch-${index}` }),
        START_AT
      )
    }
    reportVisiblePRRefreshCandidates(
      Array.from({ length: 25 }, (_, index) =>
        makeCandidate({
          repoPath: `/visible-${index}`,
          cacheKey: `visible-${index}`,
          worktreeId: `wt-${index}`
        })
      ),
      1,
      1
    )
    const counts = () => {
      const paths = getPRForBranchOutcomeMock.mock.calls.map(([path]) => String(path))
      return {
        watch: paths.filter((path) => path.startsWith(WATCHED)).length,
        visible: paths.filter((path) => path.startsWith('/visible-')).length
      }
    }
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    const early = counts()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    const late = counts()
    // Past the first passes both kinds stay overdue; each must still get starts.
    expect(late.watch - early.watch).toBeGreaterThanOrEqual(20)
    expect(late.visible - early.visible).toBeGreaterThanOrEqual(20)
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

  it('bounds the check pages of watch reads only, never a visible read', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    await startWatch()
    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(30_000)
    const options = (repoPath: string) =>
      getPRForBranchOutcomeMock.mock.calls.find(([path]) => path === repoPath)?.[5]
    expect(watchReads()).toBe(1)
    expect(options(WATCHED)).toMatchObject({ checkPageLimit: 10 })
    expect(options('/repo')?.checkPageLimit).toBeUndefined()
  })
})
