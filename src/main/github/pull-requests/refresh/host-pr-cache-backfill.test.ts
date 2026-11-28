import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { readWorkspaceReviewPR } from '../../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import {
  createHostPRCache,
  HOST_PR_BACKFILL_TTL_MS,
  type HostPRBackfillWorktree
} from './host-pr-cache-backfill'

const repo: Repo = {
  id: 'repo-1',
  path: '/home/me/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

function worktree(
  branch: string,
  linkedPR: number | null,
  extra: Partial<HostPRBackfillWorktree> = {}
): HostPRBackfillWorktree {
  return {
    id: `repo-1::/home/me/${branch}`,
    repoId: 'repo-1',
    branch: `refs/heads/${branch}`,
    head: `${branch}-head`,
    linkedPR,
    isMainWorktree: false,
    ...extra
  }
}

function pr(state: PRInfo['state']): PRInfo {
  return {
    number: 7,
    title: 't',
    state,
    url: 'u',
    checksStatus: 'success',
    updatedAt: '',
    mergeable: 'UNKNOWN'
  }
}

function setup(
  worktrees: HostPRBackfillWorktree[],
  initial: PersistedState['githubCache']['pr'] = {}
) {
  let cache: PersistedState['githubCache'] = { pr: initial, issue: {} }
  const time = 10_000_000
  const store = {
    getGitHubCache: () => cache,
    setGitHubCache: (next: PersistedState['githubCache']) => {
      cache = next
    }
  }
  const hostCache = createHostPRCache({
    store,
    listWorktrees: async () => ({ worktrees, repos: [repo] }),
    // The served read records its own reply, as getRepoPRForBranch does on orcad.
    readPR: vi.fn(async (target: Repo, branch: string) => {
      hostCache.record(target, branch, { kind: 'found', pr: pr('merged'), fetchedAt: time })
    }),
    now: () => time
  })
  return { hostCache, cache: () => cache.pr }
}

describe('host PR cache backfill', () => {
  it('reads only linked worktrees whose entry is missing or stale, then serves the merged state', async () => {
    const linked = worktree('feature', 7)
    const rows = [linked, worktree('unlinked', null), worktree('main', 3, { isMainWorktree: true })]
    const { hostCache, cache } = setup(rows)
    await hostCache.backfill({ wait: true })
    expect(Object.keys(cache())).toEqual(['repo-1::feature'])
    expect(readWorkspaceReviewPR(linked, repo, cache())?.state).toBe('merged')
  })

  it('skips merged and fresh entries and retries an attempt only after the TTL', async () => {
    const readPR = vi.fn(async () => undefined)
    let time = 1_000_000
    const prCache = {
      'repo-1::done': { data: pr('merged'), fetchedAt: 0 },
      'repo-1::fresh': { data: pr('open'), fetchedAt: time - 1 }
    }
    const store = {
      getGitHubCache: () => ({ pr: prCache, issue: {} }),
      setGitHubCache: vi.fn()
    }
    const hostCache = createHostPRCache({
      store,
      listWorktrees: async () => ({
        worktrees: [worktree('done', 7), worktree('fresh', 7), worktree('stale', 7)],
        repos: [repo]
      }),
      readPR,
      now: () => time
    })
    await hostCache.backfill({ wait: true })
    await hostCache.backfill({ wait: true })
    expect(readPR).toHaveBeenCalledTimes(1)
    expect(readPR).toHaveBeenCalledWith(repo, 'refs/heads/stale', 7, 'stale-head', undefined)
    time += HOST_PR_BACKFILL_TTL_MS
    await hostCache.backfill({ wait: true })
    expect(readPR).toHaveBeenCalledTimes(3)
  })

  it('throttles unawaited runs so a repeated worktree.ps adds no work', async () => {
    const listWorktrees = vi.fn(async () => ({ worktrees: [], repos: [repo] }))
    const hostCache = createHostPRCache({
      store: { getGitHubCache: () => ({ pr: {}, issue: {} }), setGitHubCache: vi.fn() },
      listWorktrees,
      readPR: vi.fn(),
      now: () => 5
    })
    await hostCache.backfill()
    await hostCache.backfill()
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('counts an unchanged answer from any read as checked, without rewriting the entry', async () => {
    let time = 1_000_000
    const prCache = { 'repo-1::feature': { data: pr('open'), fetchedAt: 0 } }
    const setGitHubCache = vi.fn()
    const readPR = vi.fn(async () => undefined)
    const hostCache = createHostPRCache({
      store: { getGitHubCache: () => ({ pr: prCache, issue: {} }), setGitHubCache },
      listWorktrees: async () => ({ worktrees: [worktree('feature', 7)], repos: [repo] }),
      readPR,
      now: () => time
    })
    // A desktop client's read returns the same open PR long after the stored fetchedAt.
    hostCache.record(repo, 'feature', { kind: 'found', pr: pr('open'), fetchedAt: time })
    await hostCache.backfill({ wait: true })
    expect(setGitHubCache).not.toHaveBeenCalled()
    expect(readPR).not.toHaveBeenCalled()
    time += HOST_PR_BACKFILL_TTL_MS
    await hostCache.backfill({ wait: true })
    expect(readPR).toHaveBeenCalledTimes(1)
  })

  it('never fails the caller when listing worktrees fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hostCache = createHostPRCache({
      store: { getGitHubCache: () => ({ pr: {}, issue: {} }), setGitHubCache: vi.fn() },
      listWorktrees: async () => {
        throw new Error('listing failed')
      },
      readPR: vi.fn()
    })
    await expect(hostCache.backfill({ wait: true })).resolves.toBeUndefined()
    await expect(hostCache.backfill()).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('starts no queued read after the caller cancels', async () => {
    const controller = new AbortController()
    const readPR = vi.fn(async () => {
      controller.abort()
    })
    const hostCache = createHostPRCache({
      store: { getGitHubCache: () => ({ pr: {}, issue: {} }), setGitHubCache: vi.fn() },
      listWorktrees: async () => ({
        worktrees: ['a', 'b', 'c', 'd'].map((branch) => worktree(branch, 7)),
        repos: [repo]
      }),
      readPR
    })
    await hostCache.backfill({ wait: true, signal: controller.signal })
    // The first read cancels synchronously, so neither worker starts another.
    expect(readPR).toHaveBeenCalledTimes(1)
  })
})
