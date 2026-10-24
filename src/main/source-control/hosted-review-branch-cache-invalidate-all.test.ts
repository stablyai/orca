import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  __resetHostedReviewBranchCacheForTests,
  invalidateAllHostedReviewBranchCaches,
  withHostedReviewBranchCache
} from './hosted-review-branch-cache'

const review: HostedReviewInfo = {
  provider: 'bitbucket',
  number: 12,
  title: 'Server PR',
  state: 'open',
  url: 'https://bitbucket.example.com/projects/PRJ/repos/repo/pull-requests/12',
  status: 'neutral',
  updatedAt: '',
  mergeable: 'UNKNOWN'
}

describe('invalidateAllHostedReviewBranchCaches', () => {
  beforeEach(() => {
    __resetHostedReviewBranchCacheForTests()
  })

  it('stops serving a cached review once the provider credential changes', async () => {
    const identities = [
      { repoPath: '/repo-a', executionHostId: 'local' as const, branch: 'feat' },
      { repoPath: '/repo-b', executionHostId: 'local' as const, branch: 'main' }
    ]
    for (const identity of identities) {
      await withHostedReviewBranchCache(identity, { headOid: null }, async () => review)
    }
    // Why: after a disconnect the remote falls to another provider whose lookup fails;
    // without the flush the cache keeps answering with the disconnected server's PR.
    const failing = vi.fn(async (): Promise<HostedReviewInfo | null> => {
      throw new Error('Gitea request failed: HTTP 404')
    })

    invalidateAllHostedReviewBranchCaches()

    for (const identity of identities) {
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null, force: true }, failing)
      ).rejects.toThrow('HTTP 404')
    }
  })

  it('discards an answer that was still in flight when the credential changed', async () => {
    const identity = { repoPath: '/repo-c', executionHostId: 'local' as const, branch: 'feat' }
    let settle: (value: HostedReviewInfo | null) => void = () => {}
    const stale = withHostedReviewBranchCache(
      identity,
      { headOid: null },
      () => new Promise<HostedReviewInfo | null>((resolve) => (settle = resolve))
    )

    invalidateAllHostedReviewBranchCaches()
    settle(null)
    await stale

    const fresh = vi.fn(async () => review)
    await expect(withHostedReviewBranchCache(identity, { headOid: null }, fresh)).resolves.toEqual(
      review
    )
    expect(fresh).toHaveBeenCalledOnce()
  })
})
