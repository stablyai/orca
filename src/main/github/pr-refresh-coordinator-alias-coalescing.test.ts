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

const { sendMock, getPRForBranchOutcomeMock } = coordinatorMocks

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels queued work when a later enqueue marks the candidate invalid', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now()
    })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh(
      { ...candidate, isArchived: true, cachedFetchedAt: Date.now() },
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    const skippedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'skipped')

    expect(skippedEvents.at(-1)?.skippedReason).toBe('archived')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('does not cancel other aliases when one coalesced PR alias becomes invalid', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', state: 'merged' }),
        fetchedAt: Date.now()
      })

    const first = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a'
    })
    const second = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b'
    })
    reportVisiblePRRefreshCandidates([first, second], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh({ ...first, isArchived: true, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    enqueuePRRefresh({ ...second, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)

    const outcomeEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.outcome)

    expect(outcomeEvents.at(-1)?.aliases.map((alias) => alias.cacheKey)).toEqual([
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('probes with the survivor head after the representative alias is invalidated', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    const survivor = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b',
      currentHeadOid: 'head-b'
    })
    const representative = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a',
      currentHeadOid: 'head-a'
    })

    // Enqueue the survivor first, then the representative (active coalescing
    // promotes the latter to representative), then invalidate the representative
    // so the still-queued entry rebinds to the survivor before draining.
    enqueuePRRefresh(survivor, 'active', 80, 1)
    enqueuePRRefresh(representative, 'active', 80, 1)
    enqueuePRRefresh({ ...representative, isArchived: true }, 'active', 80, 1)
    await vi.runOnlyPendingTimersAsync()

    const probedHeads = getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.currentHeadOid)
    expect(probedHeads).toContain('head-b')
    expect(probedHeads).not.toContain('head-a')
  })

  it('probes with the survivor head after the representative worktree is pruned', async () => {
    const { enqueuePRRefresh, pruneWorktreePRRefreshAliases } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    const survivor = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b',
      currentHeadOid: 'head-b'
    })
    const representative = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a',
      currentHeadOid: 'head-a'
    })

    enqueuePRRefresh(survivor, 'active', 80, 1)
    enqueuePRRefresh(representative, 'active', 80, 1)
    pruneWorktreePRRefreshAliases('wt-a')
    await vi.runOnlyPendingTimersAsync()

    const probedHeads = getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.currentHeadOid)
    expect(probedHeads).toContain('head-b')
    expect(probedHeads).not.toContain('head-a')
  })

  it('refreshes the representative head when the same worktree re-reports a moved head', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    // Same worktree/branch, moved head, coalescing visible→visible (no promote):
    // the representative head must track the newest report before the drain.
    reportVisiblePRRefreshCandidates(
      [makeCandidate({ linkedPRNumber: 12, worktreeId: 'wt-a', currentHeadOid: 'head-a' })],
      1,
      1
    )
    reportVisiblePRRefreshCandidates(
      [makeCandidate({ linkedPRNumber: 12, worktreeId: 'wt-a', currentHeadOid: 'head-b' })],
      2,
      1
    )
    await vi.runOnlyPendingTimersAsync()

    const probedHeads = getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.currentHeadOid)
    expect(probedHeads).toContain('head-b')
    expect(probedHeads).not.toContain('head-a')
  })

  it('does not coalesce local and SSH refreshes for the same branch', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 44 }),
        fetchedAt: Date.now()
      })

    enqueuePRRefresh(makeCandidate({ cacheKey: 'local::repo-1::feature/test' }), 'active', 80, 1)
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'ssh:ssh-1::repo-1::feature/test',
        connectionId: 'ssh-1'
      }),
      'active',
      80,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      1,
      '/repo',
      'feature/test',
      null,
      null,
      null,
      { localGitExecOptions: { admissionTier: 'background' } }
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'feature/test',
      null,
      'ssh-1',
      null,
      { localGitExecOptions: { admissionTier: 'background' } }
    )
  })

  it('does not coalesce host and WSL refreshes for the same local branch', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 44 }),
        fetchedAt: Date.now()
      })

    enqueuePRRefresh(makeCandidate({ cacheKey: 'host::repo-1::feature/test' }), 'active', 80, 1)
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'wsl::repo-1::feature/test',
        localGitOptions: { wslDistro: 'Ubuntu' }
      }),
      'active',
      80,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      1,
      '/repo',
      'feature/test',
      null,
      null,
      null,
      { localGitExecOptions: { admissionTier: 'background' } }
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'feature/test',
      null,
      null,
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'background' } }
    )
  })

  it('preserves coalesced aliases across visible follow-up refreshes', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/a',
          branch: 'feature/a',
          linkedPRNumber: 12,
          worktreeId: 'wt-a'
        }),
        makeCandidate({
          cacheKey: '/repo::feature/b',
          branch: 'feature/b',
          linkedPRNumber: 12,
          worktreeId: 'wt-b'
        })
      ],
      1,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(90_000)

    const outcomeEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.outcome)

    expect(outcomeEvents).toHaveLength(2)
    expect(outcomeEvents[1].aliases.map((alias) => alias.cacheKey).sort()).toEqual([
      '/repo::feature/a',
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  describe('pruneWorktreePRRefreshAliases', () => {
    // Several local worktrees tracking the same linked PR coalesce into one
    // queue entry (same refreshKey) whose alias map keeps one entry each.
    const LINKED_PR_KEY = 'local::runtime:host::/repo::pr::42'

    function makeLinkedCandidate(worktreeId: string): GitHubPRRefreshCandidate {
      return makeCandidate({
        worktreeId,
        cacheKey: `/repo::${worktreeId}`,
        branch: `feature/${worktreeId}`,
        linkedPRNumber: 42
      })
    }

    it('drops a removed worktree alias and deletes the entry when it was the last', async () => {
      const { enqueuePRRefresh, pruneWorktreePRRefreshAliases, _getPRRefreshAliasCountForTests } =
        await import('./pr-refresh-coordinator')

      enqueuePRRefresh(makeLinkedCandidate('wt-1'), 'visible', 40, 1)
      enqueuePRRefresh(makeLinkedCandidate('wt-2'), 'visible', 40, 1)
      enqueuePRRefresh(makeLinkedCandidate('wt-3'), 'visible', 40, 1)
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(3)

      pruneWorktreePRRefreshAliases('wt-2')
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(2)

      pruneWorktreePRRefreshAliases('wt-1')
      pruneWorktreePRRefreshAliases('wt-3')
      // Last alias gone -> the whole queue entry is dropped.
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(0)
    })

    it('keeps the entry alive and rebinds the candidate when other aliases remain', async () => {
      const {
        enqueuePRRefresh,
        pruneWorktreePRRefreshAliases,
        _getPRRefreshAliasCountForTests,
        _getPRRefreshQueueSizeForTests
      } = await import('./pr-refresh-coordinator')

      // wt-1 becomes the entry's representative candidate (enqueued first).
      enqueuePRRefresh(makeLinkedCandidate('wt-1'), 'visible', 40, 1)
      enqueuePRRefresh(makeLinkedCandidate('wt-2'), 'visible', 40, 1)
      expect(_getPRRefreshQueueSizeForTests()).toBe(1)

      // Removing the representative worktree must not orphan the entry.
      pruneWorktreePRRefreshAliases('wt-1')
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
      expect(_getPRRefreshQueueSizeForTests()).toBe(1)
    })

    it('is a no-op for a worktree with no queued aliases', async () => {
      const { enqueuePRRefresh, pruneWorktreePRRefreshAliases, _getPRRefreshAliasCountForTests } =
        await import('./pr-refresh-coordinator')

      enqueuePRRefresh(makeLinkedCandidate('wt-1'), 'visible', 40, 1)
      pruneWorktreePRRefreshAliases('wt-unknown')
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
    })
  })
})
