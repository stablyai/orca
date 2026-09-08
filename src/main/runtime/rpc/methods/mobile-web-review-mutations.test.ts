import { describe, expect, it } from 'vitest'
import {
  gitHubReviewDetails,
  gitLabReviewDetails,
  hostedReviewSummary,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewRuntime,
  reviewStatus,
  runReviewMethod
} from './mobile-web-review-test-fixture'

const commentFile = {
  path: 'src/app.ts',
  status: 'modified' as const,
  additions: 1,
  deletions: 0,
  isBinary: false,
  reviewCommentLineNumbers: [4, 5]
}

function threadComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    author: 'grace',
    authorAvatarUrl: '',
    url: '',
    body: 'nit',
    createdAt: '2026-09-07',
    threadId: 'thread-1',
    ...overrides
  }
}

describe('host-projected provider review comment mutations', () => {
  it('addresses a conversation comment to the pull request own repository slug', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      addRepoIssueComment: { ok: true }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.comment',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'comment',
          body: 'Looks good.'
        },
        f.context
      )
    ).resolves.toEqual({
      provider: 'github',
      reviewNumber: 42,
      action: 'comment',
      outcome: 'completed'
    })
    expect(f.calls.at(-1)).toEqual({
      method: 'addRepoIssueComment',
      args: [
        'id:repo-1',
        42,
        'Looks good.',
        { owner: 'acme', repo: 'orca', host: 'github.example' }
      ]
    })
  })

  it('posts a merge-request comment through the GitLab project reference', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ provider: 'gitlab' }),
      getGitLabRepoWorkItemDetails: gitLabReviewDetails(),
      addGitLabRepoMRComment: { ok: true }
    })

    await runReviewMethod(
      'mobileWeb.review.comment',
      {
        ...REVIEW_IDENTITY,
        provider: 'gitlab',
        reviewNumber: 42,
        action: 'comment',
        body: 'Looks good.'
      },
      f.context
    )

    expect(f.calls.at(-1)).toEqual({
      method: 'addGitLabRepoMRComment',
      args: ['id:repo-1', 42, 'Looks good.', { host: 'gitlab.example', path: 'acme/orca' }]
    })
  })

  it('refuses an inline comment on a line the review diff does not expose', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [commentFile] })
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.comment',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'inlineComment',
          expectedReviewHead: REVIEW_HEAD,
          path: 'src/app.ts',
          line: 9,
          body: 'nit'
        },
        f.context
      )
    ).rejects.toThrow('conflict')
  })

  it('anchors an inline comment to the head the page composed it against', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [commentFile] }),
      addRepoPRReviewComment: { ok: true }
    })

    await runReviewMethod(
      'mobileWeb.review.comment',
      {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'inlineComment',
        expectedReviewHead: REVIEW_HEAD,
        path: 'src/app.ts',
        line: 5,
        startLine: 4,
        body: 'nit'
      },
      f.context
    )

    expect(f.calls.at(-1)).toMatchObject({
      method: 'addRepoPRReviewComment',
      args: ['id:repo-1', { commitId: REVIEW_HEAD, path: 'src/app.ts', line: 5, startLine: 4 }]
    })
  })

  it('replies with the provider numeric id behind the page opaque comment id', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ comments: [threadComment()] }),
      addRepoPRReviewCommentReply: { ok: true }
    })

    await runReviewMethod(
      'mobileWeb.review.comment',
      {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'reply',
        commentId: '7',
        threadId: 'thread-1',
        body: 'ack'
      },
      f.context
    )

    expect(f.calls.at(-1)).toMatchObject({
      method: 'addRepoPRReviewCommentReply',
      args: ['id:repo-1', { commentId: 7, threadId: 'thread-1', body: 'ack' }]
    })
  })

  it('does not write when the branch moves between reading the review and posting', async () => {
    let statusReads = 0
    const f = reviewRuntime({
      getRuntimeGitStatus: () => {
        statusReads += 1
        return statusReads === 1 ? reviewStatus() : reviewStatus({ branch: 'main' })
      },
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      addRepoIssueComment: { ok: true }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.comment',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'comment',
          body: 'Looks good.'
        },
        f.context
      )
    ).rejects.toThrow('conflict')
    expect(f.calls.map((call) => call.method)).not.toContain('addRepoIssueComment')
  })

  it('treats resolving an already resolved thread as done without calling the provider', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({
        comments: [threadComment({ isResolved: true })]
      })
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.comment',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'setThreadResolved',
          threadId: 'thread-1',
          resolved: true
        },
        f.context
      )
    ).resolves.toMatchObject({ action: 'setThreadResolved', resolved: true })
    expect(f.calls.map((call) => call.method)).not.toContain('resolveRepoReviewThread')
  })
})

describe('host-projected provider review management', () => {
  it('refuses reviewers the repository will not accept', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      listRepoAssignableUsers: [{ login: 'ada', name: null, avatarUrl: '' }],
      requestRepoPRReviewers: { ok: true }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.manage',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'requestReviewers',
          reviewers: ['mallory']
        },
        f.context
      )
    ).rejects.toThrow('conflict')
    expect(f.calls.map((call) => call.method)).not.toContain('requestRepoPRReviewers')
  })

  it('merges with the requested method and echoes the action back', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      mergeRepoPR: { ok: true }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.manage',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'merge',
          method: 'squash'
        },
        f.context
      )
    ).resolves.toEqual({
      provider: 'github',
      reviewNumber: 42,
      action: 'merge',
      outcome: 'completed'
    })
    expect(f.calls.at(-1)).toEqual({
      method: 'mergeRepoPR',
      args: ['id:repo-1', 42, 'squash', { owner: 'acme', repo: 'orca', host: 'github.example' }]
    })
  })

  it('edits a conversation comment by the provider numeric id and repository slug', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({
        comments: [threadComment({ threadId: undefined })]
      }),
      updateGitHubIssueCommentBySlug: { ok: true }
    })

    await runReviewMethod(
      'mobileWeb.review.manage',
      {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'updateConversationComment',
        commentId: '7',
        body: 'edited'
      },
      f.context
    )

    expect(f.calls.at(-1)).toEqual({
      method: 'updateGitHubIssueCommentBySlug',
      args: [{ owner: 'acme', repo: 'orca', host: 'github.example', commentId: 7, body: 'edited' }]
    })
  })

  it('refuses a rerun composed against a head the review has moved off', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails()
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.manage',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          action: 'rerunChecks',
          expectedReviewHead: 'd'.repeat(40)
        },
        f.context
      )
    ).rejects.toThrow('conflict')
  })

  it('refuses management on a provider with no mobile projection', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ provider: 'gitlab' }),
      getGitLabRepoWorkItemDetails: gitLabReviewDetails()
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.manage',
        { ...REVIEW_IDENTITY, provider: 'gitlab', reviewNumber: 42, action: 'merge' },
        f.context
      )
    ).rejects.toThrow('unsupported_provider')
  })
})

describe('host-projected provider review submission', () => {
  const submission = {
    ...REVIEW_IDENTITY,
    provider: 'github' as const,
    reviewNumber: 42,
    expectedReviewHead: REVIEW_HEAD,
    submissionId: 'submission_1234567890',
    action: 'approve' as const,
    summary: 'Ship it.',
    comments: []
  }

  it('submits a queued review against the pull request own repository slug', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [commentFile] }),
      submitHostedReview: { ok: true, action: 'approve', submittedComments: 1 }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.submit',
        {
          ...submission,
          comments: [
            { id: 'comment_0000000000', path: 'src/app.ts', line: 5, startLine: 4, body: 'nit' }
          ]
        },
        f.context
      )
    ).resolves.toMatchObject({
      action: 'approve',
      submittedCommentIds: ['comment_0000000000'],
      outcome: 'completed'
    })
    expect(f.calls.at(-1)?.args[0]).toMatchObject({
      repoSelector: 'id:repo-1',
      provider: 'github',
      number: 42,
      expectedHead: REVIEW_HEAD,
      repository: { owner: 'acme', repo: 'orca' },
      comments: [{ path: 'src/app.ts', line: 5, startLine: 4 }]
    })
  })

  it('refuses a verdict the review does not allow', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ state: 'merged' }),
      getRepoWorkItemDetails: gitHubReviewDetails()
    })

    await expect(runReviewMethod('mobileWeb.review.submit', submission, f.context)).rejects.toThrow(
      'conflict'
    )
  })

  it('refuses a submission the host acknowledged for a different comment count', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      submitHostedReview: { ok: true, action: 'approve', submittedComments: 3 }
    })

    await expect(runReviewMethod('mobileWeb.review.submit', submission, f.context)).rejects.toThrow(
      'host_error'
    )
  })
})
