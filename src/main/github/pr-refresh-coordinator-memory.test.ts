import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../shared/types'
import {
  PR_REFRESH_ALIAS_LIMIT,
  PR_REFRESH_QUEUE_ENTRY_LIMIT
} from '../../shared/pr-refresh-memory-limits'

const { sendToTrustedUIRendererMock } = vi.hoisted(() => ({
  sendToTrustedUIRendererMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('./client', () => ({ getPRForBranchOutcome: vi.fn() }))
vi.mock('./github-api-repository', () => ({ getOriginGitHubApiRepository: vi.fn() }))
vi.mock('./rate-limit', () => ({
  getRateLimit: vi.fn(),
  noteRepositoryRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  spendsSharedGitHubComQuota: vi.fn(() => false)
}))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCoalescedCrashBreadcrumb: vi.fn()
}))
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: sendToTrustedUIRendererMock }))

function candidate(index: number, linkedPRNumber?: number): GitHubPRRefreshCandidate {
  return {
    cacheKey: `/repo-${index}::feature-${index}`,
    repoPath: linkedPRNumber === undefined ? `/repo-${index}` : '/repo',
    branch: `feature-${index}`,
    repoKind: 'git',
    repoId: `repo-${index}`,
    worktreeId: `worktree-${index}`,
    cachedFetchedAt: Date.now(),
    linkedPRNumber
  }
}

describe('PR refresh coordinator memory admission', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    sendToTrustedUIRendererMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps distinct queued refreshes while GitHub work is delayed', async () => {
    const { enqueuePRRefresh, _getPRRefreshQueueSizeForTests } =
      await import('./pr-refresh-coordinator')

    for (let index = 0; index <= PR_REFRESH_QUEUE_ENTRY_LIMIT; index += 1) {
      enqueuePRRefresh(candidate(index), 'visible', 40, 1)
    }

    expect(_getPRRefreshQueueSizeForTests()).toBe(PR_REFRESH_QUEUE_ENTRY_LIMIT)
    expect(sendToTrustedUIRendererMock).toHaveBeenLastCalledWith(
      'gh:prRefreshEvent',
      expect.objectContaining({ status: 'skipped', skippedReason: 'capacity' })
    )
  })

  it('caps aliases coalesced behind one linked review', async () => {
    const { enqueuePRRefresh, _getPRRefreshAliasCountForTests } =
      await import('./pr-refresh-coordinator')

    for (let index = 0; index <= PR_REFRESH_ALIAS_LIMIT; index += 1) {
      enqueuePRRefresh(candidate(index, 42), 'visible', 40, 1)
    }

    expect(_getPRRefreshAliasCountForTests('local::runtime:host::/repo::pr::42')).toBe(
      PR_REFRESH_ALIAS_LIMIT
    )
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:prRefreshEvent',
      expect.objectContaining({ status: 'skipped', skippedReason: 'capacity' })
    )
  })
})
