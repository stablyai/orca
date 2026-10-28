import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceReviewTarget } from './runtime-workspace-review-target'
import { makePR } from '../github/pr-refresh-coordinator-test-harness'
import { getGitHubPRCacheKey } from '../../shared/github/github-cache-key'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { PersistedState } from '../../shared/persisted-state-types'

const boundary = vi.hoisted(() => ({ git: vi.fn(), provider: vi.fn(), blocked: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: boundary.git }))
vi.mock('../source-control/forge-provider', () => ({
  getForgeProviderForRepository: boundary.provider
}))
vi.mock('../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath: boundary.blocked }))

function target() {
  let cache: PersistedState['githubCache'] = { pr: {}, issue: {} }
  let meta: WorktreeMeta = {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: 12,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  const repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1 }
  const worktree = {
    id: 'wt-1',
    repoId: repo.id,
    path: '/repo/wt',
    branch: 'stale-listing',
    linkedPR: 12,
    isArchived: false,
    git: {
      path: '/repo/wt',
      head: 'old-head',
      branch: 'stale-listing',
      isBare: false,
      isMainWorktree: false
    }
  }
  const args = {
    repo,
    worktree,
    executionHostId: 'local' as const,
    store: {
      getGitHubCache: () => cache,
      setGitHubCache: (value: PersistedState['githubCache']) => {
        cache = value
      },
      getWorktreeMetaForHost: () => meta,
      setWorktreeMeta: (_target: unknown, updates: Partial<WorktreeMeta>) => {
        meta = { ...meta, ...updates }
        return meta
      }
    }
  }
  return {
    args,
    set cache(value) {
      cache = value
    },
    key: getGitHubPRCacheKey(repo.path, repo.id, 'current-branch')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  boundary.git.mockResolvedValue({ stdout: 'current-head\nrefs/heads/current-branch\n' })
  boundary.provider.mockResolvedValue({ id: 'github' })
  boundary.blocked.mockResolvedValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspace review target uses host identity and existing review selection', () => {
  it('uses checked-out branch/HEAD instead of the listing and looks past a stale linked PR', async () => {
    const h = target()
    h.cache = {
      pr: {
        [h.key]: {
          data: makePR({ headSha: 'other-head', headRefName: 'previous-branch' }),
          fetchedAt: 500
        }
      },
      issue: {}
    }
    const result = await workspaceReviewTarget(h.args)
    expect(result).toMatchObject({
      branch: 'current-branch',
      linkedPR: null,
      candidate: {
        branch: 'current-branch',
        currentHeadOid: 'current-head',
        linkedPRNumber: null,
        cachedFetchedAt: null,
        cachedPRState: null
      }
    })
  })

  it('reads and clears the executing host cache when fallback repo metadata belongs elsewhere', async () => {
    const h = target()
    const repo = { ...h.args.repo, executionHostId: 'ssh:other' as const, connectionId: 'other' }
    const otherKey = getGitHubPRCacheKey(repo.path, repo.id, 'current-branch', undefined, 'other')
    const legacyPathKey = getGitHubPRCacheKey(repo.path, undefined, 'current-branch')
    const runtimeKey = getGitHubPRCacheKey(
      repo.path,
      repo.id,
      'current-branch',
      undefined,
      null,
      'runtime:other'
    )
    const stale = {
      data: makePR({ headSha: 'old-head', headRefName: 'previous-branch' }),
      fetchedAt: 500
    }
    const other = { data: makePR({ number: 99 }), fetchedAt: 600 }
    h.cache = {
      pr: { [h.key]: stale, [legacyPathKey]: stale, [otherKey]: other, [runtimeKey]: other },
      issue: {}
    }
    const args = { ...h.args, repo }
    expect(await workspaceReviewTarget(args)).toMatchObject({
      linkedPR: null,
      candidate: {
        cacheKey: h.key,
        linkedPRNumber: null,
        fallbackPRNumber: null,
        cachedFetchedAt: null
      }
    })
    expect(h.args.store.getWorktreeMetaForHost().linkedPR).toBeNull()
    expect(h.args.store.getGitHubCache().pr).toEqual({ [otherKey]: other, [runtimeKey]: other })
    expect(await workspaceReviewTarget(args)).toMatchObject({
      linkedPR: null,
      candidate: { linkedPRNumber: null, fallbackPRNumber: null, cachedFetchedAt: null }
    })
    expect(h.args.store.getGitHubCache().pr[otherKey]).toBe(other)
  })

  it('does not re-adopt an old durable PR after branch discovery replaces the cache', async () => {
    const h = target()
    h.cache = {
      pr: {
        [h.key]: {
          data: makePR({ number: 12, headSha: 'old-head', headRefName: 'previous-branch' }),
          fetchedAt: 500
        }
      },
      issue: {}
    }
    await workspaceReviewTarget(h.args)
    h.cache = {
      pr: {
        [h.key]: {
          data: makePR({ number: 13, headSha: 'current-head', headRefName: 'current-branch' }),
          fetchedAt: 1000
        }
      },
      issue: {}
    }
    expect(await workspaceReviewTarget(h.args)).toMatchObject({
      linkedPR: null,
      candidate: { linkedPRNumber: null, cachedPRState: 'open' }
    })
  })

  it('preserves a concurrent user relink while provider resolution is awaited', async () => {
    const h = target()
    h.cache = {
      pr: {
        [h.key]: {
          data: makePR({ number: 12, headSha: 'old-head', headRefName: 'previous-branch' }),
          fetchedAt: 500
        }
      },
      issue: {}
    }
    boundary.provider.mockImplementationOnce(async () => {
      h.args.store.setWorktreeMeta({}, { linkedPR: 13 })
      return { id: 'github' }
    })
    expect(await workspaceReviewTarget(h.args)).toMatchObject({
      linkedPR: 13,
      candidate: { linkedPRNumber: 13 }
    })
    expect(h.args.store.getWorktreeMetaForHost().linkedPR).toBe(13)
    expect(h.args.store.getGitHubCache().pr[h.key]?.data?.number).toBe(12)
  })

  it('keeps a renamed branch pinned when it is still at the PR head', async () => {
    const h = target()
    h.cache = {
      pr: {
        [h.key]: {
          data: makePR({ headSha: 'current-head', headRefName: 'previous-branch' }),
          fetchedAt: 500
        }
      },
      issue: {}
    }
    expect(await workspaceReviewTarget(h.args)).toMatchObject({
      candidate: { linkedPRNumber: 12, cachedFetchedAt: 500 }
    })
  })

  it.each([
    { state: 'open', headSha: 'current-head', expected: 12 },
    { state: 'merged', headSha: 'current-head', expected: 12 },
    {
      state: 'merged',
      headSha: 'other-head',
      confirmedContainedHeadOid: 'current-head',
      expected: 12
    },
    { state: 'merged', headSha: 'other-head', expected: null }
  ] as const)(
    'uses only a head-current cached PR as an implicit merged fallback: %j',
    async ({ expected, ...pr }) => {
      const h = target()
      h.args.store.setWorktreeMeta({}, { linkedPR: null })
      h.cache = { pr: { [h.key]: { data: makePR(pr), fetchedAt: 500 } }, issue: {} }
      expect((await workspaceReviewTarget(h.args)).candidate).toMatchObject({
        linkedPRNumber: null,
        fallbackPRNumber: expected,
        fallbackPRSource: expected === null ? null : 'pr-cache'
      })
    }
  )

  it('keeps folders, stopped WSL hosts, and other providers out of GitHub scheduling', async () => {
    const h = target()
    expect(
      (await workspaceReviewTarget({ ...h.args, repo: { ...h.args.repo, kind: 'folder' } }))
        .candidate
    ).toBeNull()
    expect(boundary.git).not.toHaveBeenCalled()
    boundary.blocked.mockResolvedValueOnce(true)
    expect((await workspaceReviewTarget(h.args)).candidate).toBeNull()
    expect(boundary.git).not.toHaveBeenCalled()
    boundary.provider.mockResolvedValueOnce({ id: 'gitlab' })
    expect((await workspaceReviewTarget(h.args)).candidate).toBeNull()
  })

  it('refuses a remote execution owner rather than running local Git', async () => {
    const h = target()
    await expect(
      workspaceReviewTarget({ ...h.args, executionHostId: 'runtime:remote' })
    ).rejects.toThrow()
    expect(boundary.git).not.toHaveBeenCalled()
    expect(boundary.provider).not.toHaveBeenCalled()
  })
})
