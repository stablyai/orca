import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { setPRAutoRefreshCadence } from '../../../../shared/source-control/hosted-review/review-refresh-policy'
import type { GitHubPRRefreshEvent } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { withNewerCacheEntries } from '../../../../shared/github/cache/github-cache-bounds'
import { addPRRefreshEventListener, enqueuePRRefresh } from './pr-refresh-coordinator'
import { readWorkspacePR, type WorkspacePRReadWorktree } from './workspace-pr-read'

vi.mock('./pr-refresh-coordinator', () => ({
  addPRRefreshEventListener: vi.fn(),
  enqueuePRRefresh: vi.fn()
}))
const enqueue = vi.mocked(enqueuePRRefresh)
let broadcast: ((event: GitHubPRRefreshEvent) => void) | undefined
vi.mocked(addPRRefreshEventListener).mockImplementation((next) => {
  broadcast = next
  return () => {}
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these fields.
const repo = { id: 'repo-1', path: '/repos/orca', kind: 'git' } as Repo
const worktree: WorkspacePRReadWorktree = {
  id: 'repo-1::/repos/orca-wt',
  branch: 'refs/heads/fix-list',
  head: 'abc123',
  linkedPR: null
}
const cacheKey = 'repo-1::fix-list'
const NOW = Date.parse('2026-11-23T12:00:00Z')
const HOUR = 60 * 60_000

function pr(state: PRInfo['state']): PRInfo {
  return {
    number: 42,
    title: 'Fix the list',
    state,
    url: 'https://github.com/o/r/pull/42',
    checksStatus: 'pending',
    updatedAt: '2026-11-23T00:00:00Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123'
  }
}

/** A main-process store with no window: only this module writes its cache. */
function storeWith(data: PRInfo | null, ageMs: number, repos: Repo[] = [repo]) {
  let cache: PersistedState['githubCache'] = {
    pr: { [cacheKey]: { data, fetchedAt: NOW - ageMs, fetchedHeadOid: 'abc123' } as never },
    issue: {}
  }
  return {
    getRepos: () => repos,
    getGitHubCache: () => cache,
    setGitHubCache: (next: PersistedState['githubCache']) => {
      cache = next
    }
  }
}

beforeEach(() => {
  enqueue.mockReset()
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
  setPRAutoRefreshCadence('default')
})

describe('a workspace PR read outside its row', () => {
  it('queues a stale open PR as background work and keeps its merge with no window open', () => {
    const store = storeWith(pr('open'), HOUR)
    expect(readWorkspacePR(store, worktree, repo)?.state).toBe('open')
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [candidate, reason, priority] = enqueue.mock.calls[0]
    expect(reason).toBe('swr')
    expect(priority).toBeLessThan(40)
    // The branch is deleted on merge: the read finds the PR by its cached number.
    expect(candidate).toMatchObject({ cacheKey, branch: 'fix-list', fallbackPRNumber: 42 })

    // The read's refresh event, as every window is sent it, with none open here.
    broadcast!({
      sequence: 1,
      reason: 'swr',
      aliases: [{ ...candidate, repoId: repo.id }],
      outcome: { kind: 'found', pr: pr('merged'), fetchedAt: NOW + 1_000 }
    })
    expect(readWorkspacePR(store, worktree, repo)?.state).toBe('merged')
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it("keeps main's newer read when a window saves an older copy of the cache", () => {
    const older = { data: pr('open'), fetchedAt: NOW - HOUR }
    const newer = { data: pr('merged'), fetchedAt: NOW }
    const saved = withNewerCacheEntries({ [cacheKey]: newer }, { [cacheKey]: older })
    expect(saved[cacheKey]).toBe(newer)
  })

  it('writes nothing back for a repo no longer registered', () => {
    const store = storeWith(pr('open'), HOUR)
    readWorkspacePR(store, worktree, repo)
    const removed = storeWith(pr('open'), HOUR, [])
    readWorkspacePR(removed, worktree, repo)
    broadcast!({
      sequence: 2,
      reason: 'swr',
      aliases: [{ cacheKey, repoId: repo.id, repoPath: repo.path, branch: 'fix-list' }],
      outcome: { kind: 'found', pr: pr('merged'), fetchedAt: NOW + 1_000 }
    })
    expect(readWorkspacePR(removed, worktree, repo)?.state).toBe('open')
  })

  it('never probes again a branch that had no PR while its head and link are unchanged', () => {
    readWorkspacePR(storeWith(null, 24 * HOUR), worktree, repo)
    expect(enqueue).not.toHaveBeenCalled()
    readWorkspacePR(storeWith(null, 24 * HOUR), { ...worktree, head: 'def456' }, repo)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('never reads a final PR again, however old, even with pending checks', () => {
    readWorkspacePR(storeWith(pr('merged'), 24 * HOUR), worktree, repo)
    readWorkspacePR(storeWith(pr('closed'), 24 * HOUR), worktree, repo)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('reads nothing while fresh or with automatic refresh off', () => {
    readWorkspacePR(storeWith(pr('open'), 5_000), worktree, repo)
    setPRAutoRefreshCadence('off')
    readWorkspacePR(storeWith(pr('open'), HOUR), worktree, repo)
    expect(enqueue).not.toHaveBeenCalled()
  })
})
