import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

async function load() {
  // resetPRRefreshCoordinatorMocks resets modules, so both must come from the same fresh graph.
  const coordinator = await import('./pr-refresh-coordinator')
  const activity = await import('../git/local-worktree-create-activity')
  return { coordinator, activity }
}

describe('PR refresh queue during a local create', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds a local background refresh until the create settles', async () => {
    const { coordinator, activity } = await load()
    const release = activity.holdLocalWorktreeCreate()

    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
  })

  it('resumes background refreshes at the deadline even while a create still runs', async () => {
    const { coordinator, activity } = await load()
    activity.holdLocalWorktreeCreate()

    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(activity.LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS - 1)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
  })

  it('answers a manual refresh at once', async () => {
    const { coordinator, activity } = await load()
    activity.holdLocalWorktreeCreate()

    await expect(coordinator.refreshPRNow(makeCandidate(), 'manual')).resolves.toMatchObject({
      kind: 'found'
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
  })

  it('does not hold an SSH repo, whose Git runs on another machine', async () => {
    const { coordinator, activity } = await load()
    activity.holdLocalWorktreeCreate()

    coordinator.reportVisiblePRRefreshCandidates(
      [makeCandidate({ connectionId: 'conn-1', cacheKey: 'ssh::feature/test' })],
      1,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
  })

  it('runs an SSH refresh due later on time while a local refresh is held', async () => {
    const { coordinator, activity } = await load()
    activity.holdLocalWorktreeCreate()
    coordinator.enqueuePRRefresh(makeCandidate(), 'visible', 40, 1)
    await vi.advanceTimersByTimeAsync(10)
    coordinator.enqueuePRRefresh(
      makeCandidate({ connectionId: 'conn-1', cacheKey: 'ssh::feature/test', repoPath: '/ssh' }),
      'post-push',
      100,
      1
    )

    await vi.advanceTimersByTimeAsync(10_000)
    expect(getPRForBranchOutcomeMock.mock.calls.map(([repoPath]) => repoPath)).toEqual(['/ssh'])
  })

  it('never substitutes a held local refresh for a paced one', async () => {
    const { coordinator, activity } = await load()
    // Spend the background budget so the next SSH visible refresh has a pacing delay.
    coordinator.reportVisiblePRRefreshCandidates(
      [makeCandidate({ connectionId: 'conn-1', cacheKey: 'ssh1::b1', repoPath: '/ssh1' })],
      1,
      1
    )
    await vi.advanceTimersByTimeAsync(50)
    getPRForBranchOutcomeMock.mockClear()
    activity.holdLocalWorktreeCreate()

    coordinator.reportVisiblePRRefreshCandidates(
      [makeCandidate({ connectionId: 'conn-1', cacheKey: 'ssh2::b2', repoPath: '/ssh2' })],
      2,
      1
    )
    coordinator.enqueuePRRefresh(
      makeCandidate({ cacheKey: '/repoB::b', repoPath: '/repoB', worktreeId: 'wt-b' }),
      'active',
      10
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })
})
