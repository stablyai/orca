import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { setPRAutoRefreshCadence } from '../../../../shared/source-control/hosted-review/review-refresh-policy'
import type { PRRefreshOutcomeObserver } from './pr-refresh-event-publisher'
import { addPRRefreshOutcomeObserver, enqueuePRRefresh } from './pr-refresh-coordinator'
import { readWorkspacePR, type WorkspacePRReadWorktree } from './workspace-pr-read'

vi.mock('./pr-refresh-coordinator', () => ({
  addPRRefreshOutcomeObserver: vi.fn(),
  enqueuePRRefresh: vi.fn()
}))
const enqueue = vi.mocked(enqueuePRRefresh)
let observer: PRRefreshOutcomeObserver | undefined
vi.mocked(addPRRefreshOutcomeObserver).mockImplementation((next) => {
  observer = next
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
function storeWith(data: PRInfo, ageMs: number) {
  let cache: PersistedState['githubCache'] = {
    pr: { [cacheKey]: { data, fetchedAt: NOW - ageMs } },
    issue: {}
  }
  return {
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

    observer!(candidate, { kind: 'found', pr: pr('merged'), fetchedAt: NOW + 1_000 }, [])
    expect(readWorkspacePR(store, worktree, repo)?.state).toBe('merged')
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
