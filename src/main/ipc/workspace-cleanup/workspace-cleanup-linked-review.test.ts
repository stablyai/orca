import { describe, expect, it } from 'vitest'
import { getGitHubPRCacheKeyCandidates } from '../../../shared/github/cache/github-cache-key'
import { getWorkspaceCleanupMergeReasons } from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  readWorkspaceCleanupReview,
  workspaceCleanupMergedReview,
  type WorkspaceCleanupLinkedPRReader,
  type WorkspaceCleanupReview
} from './workspace-cleanup-linked-review'

const HEAD = 'a'.repeat(40)
const repo = { id: 'repo-1', path: '/repos/app', connectionId: null, executionHostId: null }
const worktree = {
  branch: 'refs/heads/shrimp',
  linkedPR: 2219,
  suppressedGitHubPR: null,
  linkedWorkItem: null,
  linkedItems: [],
  head: HEAD
}
// The branch was looked up before its PR existed: a "no PR" answer at today's HEAD.
const staleNoPRCache = {
  [getGitHubPRCacheKeyCandidates(repo, 'shrimp')[0]]: {
    data: null,
    fetchedAt: 1,
    fetchedHeadOid: HEAD
  }
}
const mergedPR = (headSha: string): WorkspaceCleanupReview => ({
  number: 2219,
  state: 'merged',
  headSha
})

async function mergeReasons(readLinkedPR: WorkspaceCleanupLinkedPRReader) {
  const review = await readWorkspaceCleanupReview(worktree, repo, staleNoPRCache, readLinkedPR)
  // A squash merge: HEAD's commits are not ancestors of the default branch.
  return getWorkspaceCleanupMergeReasons({
    headInDefaultBranch: false,
    aheadOfDefault: 3,
    mergedReview: workspaceCleanupMergedReview(review, HEAD)
  })
}

describe('workspace cleanup linked review', () => {
  it('reads the linked PR past a cached miss at the same HEAD and classifies its merge', async () => {
    const reads: number[] = []
    const reasons = await mergeReasons(async (target) => {
      reads.push(target.linkedPR!)
      return mergedPR(HEAD)
    })
    expect(reads).toEqual([2219])
    expect(reasons).toEqual(['merged'])
  })

  it('does not classify a merged linked PR whose head is not HEAD', async () => {
    expect(await mergeReasons(async () => mergedPR('b'.repeat(40)))).toEqual([])
  })
})
