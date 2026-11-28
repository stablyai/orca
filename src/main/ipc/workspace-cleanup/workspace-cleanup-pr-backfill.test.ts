import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { PRSnapshotReply } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Repo } from '../../../shared/repository/repo-types'
import type { HostPRBackfillWorktree } from '../../github/pull-requests/refresh/host-pr-cache-backfill'
import { keepMainRecordedPREntries } from '../../github/pull-requests/refresh/main-recorded-pr-entries'
import { readCachedMergedReview } from './workspace-cleanup-merge-evidence'
import { createWorkspaceCleanupPRBackfill } from './workspace-cleanup-pr-backfill'

const HEAD = 'a'.repeat(40)
const NOW = 10_000_000
const repo: Repo = {
  id: 'repo-1',
  path: '/repos/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 0
}
// A bot-made workspace no sidebar row shows, so auto PR refresh never read it after its merge.
const shrimp: HostPRBackfillWorktree & { suppressedGitHubPR: null } = {
  id: 'repo-1::/repos/shrimp',
  repoId: 'repo-1',
  branch: 'refs/heads/shrimp',
  head: HEAD,
  linkedPR: 2219,
  isMainWorktree: false,
  suppressedGitHubPR: null
}
const mergedPR = (headSha: string): PRInfo => ({
  number: 2219,
  title: 't',
  state: 'merged',
  url: 'https://github.com/o/r/pull/2219',
  checksStatus: 'success',
  updatedAt: '',
  mergeable: 'UNKNOWN',
  headSha
})

function setup(readPR: () => Promise<PRSnapshotReply>) {
  // Looked up before the PR existed: a "no PR" answer at today's HEAD.
  let cache: PersistedState['githubCache'] = {
    pr: { 'repo-1::shrimp': { data: null, fetchedAt: 1 } },
    issue: {}
  }
  const store = {
    getGitHubCache: () => cache,
    setGitHubCache: (next: PersistedState['githubCache']) => {
      cache = next
    }
  }
  const getRepoPRForBranch = vi.fn(readPR)
  const backfill = createWorkspaceCleanupPRBackfill(
    store,
    {
      listHostPRCacheWorktrees: async () => ({ worktrees: [shrimp], repos: [repo] }),
      getRepoPRForBranch
    },
    () => NOW
  )
  return {
    backfill,
    store,
    getRepoPRForBranch,
    merged: () => readCachedMergedReview(shrimp, repo, cache.pr, HEAD)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('workspace cleanup PR backfill', () => {
  it('classifies a hidden workspace merged once its stale linked PR is read', async () => {
    const { backfill, merged, getRepoPRForBranch } = setup(async () => ({
      kind: 'found',
      pr: mergedPR(HEAD),
      fetchedAt: NOW
    }))
    expect(merged()).toBeUndefined()
    await backfill.backfill({ wait: true })
    expect(getRepoPRForBranch).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/shrimp',
      2219,
      null,
      false,
      HEAD,
      'visible',
      undefined,
      undefined,
      undefined
    )
    expect(merged()).toEqual({ number: 2219, provider: 'github', containsHead: true })
  })

  it('does not count a merged PR whose head is not the workspace HEAD', async () => {
    const { backfill, merged } = setup(async () => ({
      kind: 'found',
      pr: mergedPR('b'.repeat(40)),
      fetchedAt: NOW
    }))
    await backfill.backfill({ wait: true })
    expect(merged()?.containsHead).toBe(false)
  })

  it('keeps the offline answer when the read fails, times out, or the scan cancels', async () => {
    const failed = setup(async () => {
      throw new Error('gh failed')
    })
    await failed.backfill.backfill({ wait: true })
    expect(failed.merged()).toBeUndefined()

    vi.useFakeTimers()
    const hung = setup(() => new Promise<never>(() => undefined))
    const waited = hung.backfill.backfill({ wait: true })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(waited).resolves.toBeUndefined()
    expect(hung.merged()).toBeUndefined()

    const cancelled = setup(() => new Promise<never>(() => undefined))
    const controller = new AbortController()
    const run = cancelled.backfill.backfill({ wait: true, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(run).resolves.toBeUndefined()
    expect(cancelled.merged()).toBeUndefined()
  })

  it("keeps main's newer answer through the renderer's whole-cache save, until the renderer has a newer one", async () => {
    const { backfill, store } = setup(async () => ({
      kind: 'found',
      pr: mergedPR(HEAD),
      fetchedAt: NOW
    }))
    await backfill.backfill({ wait: true })
    const rendererSave = { pr: { 'repo-1::shrimp': { data: null, fetchedAt: 1 } }, issue: {} }
    const kept = keepMainRecordedPREntries(rendererSave, store.getGitHubCache(), NOW + 1)
    expect(kept.pr['repo-1::shrimp']?.data?.state).toBe('merged')

    const newer = { pr: { 'repo-1::shrimp': { data: null, fetchedAt: NOW + 5 } }, issue: {} }
    expect(keepMainRecordedPREntries(newer, store.getGitHubCache(), NOW + 6)).toBe(newer)
  })
})
