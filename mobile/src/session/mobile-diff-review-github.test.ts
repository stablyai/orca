import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../src/shared/github/comment-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'
import {
  applyMobileDiffReviewGitHubViewed,
  buildMobileDiffReviewGitHub,
  canCommentOnGitHub
} from './mobile-diff-review-github'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'nwparker',
    authorAvatarUrl: '',
    body: 'Use radii.surface here.',
    createdAt: '2026-11-01T00:00:00Z',
    url: 'https://github.com/o/r/pull/1#discussion_r1',
    ...overrides
  }
}

function details(overrides: Partial<GitHubWorkItemDetails>): GitHubWorkItemDetails {
  return {
    item: {
      id: 'pr-1',
      type: 'pr',
      number: 1,
      title: 'PR',
      state: 'open',
      url: 'https://github.com/o/r/pull/1',
      labels: [],
      updatedAt: '2026-11-01T00:00:00Z',
      author: 'kelvin'
    },
    body: '',
    comments: [],
    headSha: 'head',
    pullRequestId: 'PR_node',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        isBinary: false,
        reviewCommentLineNumbers: [10, 11, 12],
        viewerViewedState: 'DISMISSED'
      }
    ],
    ...overrides
  }
}

const branchItem = buildMobileDiffReviewQueue({
  worktreeId: 'wt',
  statusEntries: [],
  branchEntries: [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1 }],
  comments: [],
  reviewState: { version: 1, files: {} }
})

describe('the diff screen’s GitHub pull request', () => {
  it('puts each current thread under its end line and leaves outdated ones out', () => {
    const github = buildMobileDiffReviewGitHub({
      prNumber: 1,
      prRepo: null,
      localHeadOid: 'head',
      details: details({
        comments: [
          comment({ id: 1, path: 'src/a.ts', line: 12, startLine: 10, threadId: 'T1' }),
          comment({ id: 2, path: 'src/a.ts', line: 12, threadId: 'T1' }),
          comment({ id: 3, path: 'src/a.ts', line: 4, threadId: 'T2', isOutdated: true })
        ]
      })
    })
    const threads = github.threadsByPath.get('src/a.ts')
    expect([...(threads?.keys() ?? [])]).toEqual([12])
    expect(threads?.get(12)?.[0]?.replies.map((reply) => reply.id)).toEqual([2])
  })

  it('takes viewed state for the PR’s files from GitHub', () => {
    const github = buildMobileDiffReviewGitHub({
      prNumber: 1,
      prRepo: null,
      localHeadOid: 'head',
      details: details({})
    })
    expect(applyMobileDiffReviewGitHubViewed(branchItem, github)[0]).toMatchObject({
      isReviewed: false,
      changedSinceReview: true
    })
  })

  it('leaves viewed state on the phone when GitHub sent none for the file', () => {
    const github = buildMobileDiffReviewGitHub({
      prNumber: 1,
      prRepo: null,
      localHeadOid: 'head',
      details: details({
        pullRequestId: undefined,
        files: [
          { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, isBinary: false }
        ]
      })
    })
    const viewedLocally = branchItem.map((item) => ({ ...item, isReviewed: true }))
    expect(applyMobileDiffReviewGitHubViewed(viewedLocally, github)[0]?.isReviewed).toBe(true)
  })

  it('offers Comment on GitHub only on commentable lines while the branch is at the PR head', () => {
    const atHead = buildMobileDiffReviewGitHub({
      prNumber: 1,
      prRepo: null,
      localHeadOid: 'head',
      details: details({})
    })
    const item = branchItem[0] ?? null
    expect(canCommentOnGitHub(atHead, item, { startLine: 10, line: 12 })).toBe(true)
    expect(canCommentOnGitHub(atHead, item, { startLine: 12, line: 13 })).toBe(false)
    const ahead = buildMobileDiffReviewGitHub({
      prNumber: 1,
      prRepo: null,
      localHeadOid: 'unpushed',
      details: details({})
    })
    expect(ahead.linesMatch).toBe(false)
    expect(canCommentOnGitHub(ahead, item, { startLine: 10, line: 10 })).toBe(false)
  })
})
