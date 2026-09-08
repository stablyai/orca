import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../../shared/mobile-web/bridge-limits'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import {
  gitHubReviewDetails,
  gitLabReviewDetails,
  hostedReviewSummary,
  REVIEW_BRANCH,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewRuntime,
  reviewStatus,
  runReviewMethod
} from './mobile-web-review-test-fixture'

describe('host-projected provider review reads', () => {
  it('projects a pull request into the page contract without naming the host worktree', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({
        comments: [
          {
            id: 7,
            author: 'grace',
            authorAvatarUrl: '',
            url: '',
            body: 'nit',
            createdAt: '2026-09-07',
            threadId: 'thread-1'
          }
        ],
        files: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            isBinary: false,
            reviewCommentLineNumbers: [1, 2]
          }
        ]
      })
    })

    const result = await runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)

    expect(result).toMatchObject({
      observedHead: REVIEW_HEAD,
      branch: REVIEW_BRANCH,
      review: {
        provider: 'github',
        number: 42,
        detailsState: 'loaded',
        author: 'ada',
        allowedSubmissionActions: ['comment', 'approve', 'request-changes'],
        comments: [{ id: '7', kind: 'inline', allowedActions: ['reply', 'set-resolved'] }],
        files: [{ path: 'src/app.ts', commentableLines: [1, 2] }],
        reviewRequests: [{ login: 'grace', name: null }]
      }
    })
    expect(JSON.stringify(result)).not.toMatch(/workspaceId|private/)
    expect(f.calls.map((call) => call.method)).toEqual([
      'getRuntimeGitStatus',
      'getHostedReviewForBranch',
      'getRepoWorkItemDetails'
    ])
  })

  it('projects a merge request through the GitLab arm', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ provider: 'gitlab' }),
      getGitLabRepoWorkItemDetails: gitLabReviewDetails({
        comments: [
          {
            id: 9,
            author: 'grace',
            authorAvatarUrl: '',
            url: '',
            body: 'nit',
            createdAt: '2026-09-07',
            threadId: 'discussion-1'
          }
        ],
        files: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            isBinary: false,
            diff: '@@ -1 +1 @@\n-old\n+new\n'
          }
        ]
      })
    })

    await expect(
      runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)
    ).resolves.toMatchObject({
      review: {
        provider: 'gitlab',
        detailsState: 'loaded',
        allowedSubmissionActions: ['comment'],
        comments: [{ id: '9', allowedActions: ['set-resolved'] }],
        files: [{ path: 'src/app.ts', commentableLines: [1] }],
        checks: []
      }
    })
  })

  it.each([
    ['github', false],
    ['gitlab', false],
    ['github', true]
  ] as const)(
    'fits escaped %s review content with crowded checks=%s in the shell envelope',
    async (provider, crowded) => {
      const comments = Array.from({ length: 32 }, (_, id) => ({
        id,
        author: 'a'.repeat(160),
        authorAvatarUrl: '',
        url: '',
        body: '\u0000'.repeat(4096),
        createdAt: '2026-09-07'
      }))
      const details = {
        body: '\u0000'.repeat(32 * 1024),
        comments,
        files: Array.from({ length: 48 }, (_, index) => ({
          path: `${index}${'界'.repeat(1000)}`,
          ...(crowded ? { oldPath: `${index}${'旧'.repeat(1000)}` } : {}),
          status: 'modified' as const,
          additions: 0,
          deletions: 0,
          isBinary: false
        }))
      }
      const f = reviewRuntime({
        getRuntimeGitStatus: reviewStatus(),
        getHostedReviewForBranch: hostedReviewSummary({ provider }),
        ...(provider === 'github'
          ? {
              getRepoWorkItemDetails: gitHubReviewDetails({
                ...details,
                checks: crowded
                  ? Array.from({ length: 128 }, () => ({
                      name: '\u0000'.repeat(256),
                      status: 'completed' as const,
                      conclusion: 'success' as const,
                      url: null
                    }))
                  : []
              })
            }
          : { getGitLabRepoWorkItemDetails: gitLabReviewDetails(details) })
      })
      const result = (await runReviewMethod(
        'mobileWeb.review.read',
        REVIEW_IDENTITY,
        f.context
      )) as { review: MobileWebProviderReview }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
      )
      expect(result.review.commentsTruncated).toBe(true)
      if (!crowded) {
        expect(result.review.comments.length).toBeGreaterThan(0)
        expect(result.review.comments.at(-1)?.id).toBe('31')
        expect(result.review.files).toHaveLength(48)
      } else {
        expect(result.review.filesTruncated).toBe(true)
        expect(result.review.files.length).toBeLessThan(48)
      }
    }
  )

  it('refuses a read composed against a head the repository has moved off', async () => {
    const f = reviewRuntime({ getRuntimeGitStatus: reviewStatus({ head: 'c'.repeat(40) }) })

    await expect(
      runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)
    ).rejects.toThrow('conflict')
  })

  it('answers a branch with no hosted review without reading provider details', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: null
    })

    await expect(
      runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)
    ).resolves.toMatchObject({ review: null })
    expect(f.calls.map((call) => call.method)).toEqual([
      'getRuntimeGitStatus',
      'getHostedReviewForBranch'
    ])
  })

  it('reports an unreadable work item as unavailable rather than failing the read', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: () => {
        throw new Error('rate_limited')
      }
    })

    await expect(
      runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)
    ).resolves.toMatchObject({
      review: { detailsState: 'unavailable', canComment: false, allowedSubmissionActions: [] }
    })
  })

  it('reports a work item answered for another review as unavailable', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({
        item: { ...gitHubReviewDetails().item, number: 7 }
      })
    })

    await expect(
      runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)
    ).resolves.toMatchObject({ review: { detailsState: 'unavailable' } })
  })

  it('marks a provider with no mobile projection unsupported', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ provider: 'bitbucket' })
    })

    await expect(
      runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)
    ).resolves.toMatchObject({ review: { provider: 'bitbucket', detailsState: 'unsupported' } })
  })

  it('derives the repo selector from the addressed worktree', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: null
    })

    await runReviewMethod('mobileWeb.review.read', REVIEW_IDENTITY, f.context)

    expect(f.calls[1]?.args[0]).toMatchObject({
      repoSelector: 'id:repo-1',
      branch: REVIEW_BRANCH,
      currentHeadOid: REVIEW_HEAD
    })
  })
})

describe('host-projected provider review queries', () => {
  it('clips a check-details answer whose job logs overrun one transport payload', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({
        checks: [
          { name: 'build', status: 'completed', conclusion: 'failure', url: null, checkRunId: 9 }
        ]
      }),
      getRepoPRCheckDetails: {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null,
        title: null,
        summary: null,
        annotations: [],
        jobs: Array.from({ length: 40 }, (_, index) => ({
          name: `job-${index}`,
          status: 'completed',
          conclusion: index === 39 ? 'failure' : 'success',
          logTail: 'x'.repeat(32 * 1024),
          steps: []
        }))
      }
    })

    const result = (await runReviewMethod(
      'mobileWeb.review.query',
      {
        ...REVIEW_IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        query: 'checkDetails',
        checkName: 'build',
        checkRunId: 9
      },
      f.context
    )) as { details: { jobs: { name: string }[] } }

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024)
    expect(result.details.jobs.length).toBeLessThan(40)
    expect(result.details.jobs.at(-1)?.name).toBe('job-39')
  })

  it('refuses check details for a check the review does not carry', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails()
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.query',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          reviewNumber: 42,
          query: 'checkDetails',
          checkName: 'build'
        },
        f.context
      )
    ).rejects.toThrow('conflict')
  })

  it('lists assignable users for the review it was asked about', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      listRepoAssignableUsers: [
        { login: 'ada', name: 'Ada', avatarUrl: '' },
        { login: 'grace', name: null, avatarUrl: '' }
      ]
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.query',
        { ...REVIEW_IDENTITY, provider: 'github', reviewNumber: 42, query: 'assignableUsers' },
        f.context
      )
    ).resolves.toMatchObject({
      query: 'assignableUsers',
      users: [
        { login: 'ada', name: 'Ada' },
        { login: 'grace', name: null }
      ]
    })
    expect(f.calls.at(-1)?.args).toEqual(['id:repo-1'])
  })

  it('bounds assignable users to the page contract', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails(),
      listRepoAssignableUsers: Array.from({ length: 100 }, (_, index) => ({
        login: `user-${index}`
      }))
    })
    const result = (await runReviewMethod(
      'mobileWeb.review.query',
      { ...REVIEW_IDENTITY, provider: 'github', reviewNumber: 42, query: 'assignableUsers' },
      f.context
    )) as { users: unknown[] }
    expect(result.users).toHaveLength(64)
  })

  it('reports an unavailable provider read as conflict instead of unsupported provider', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: () => {
        throw new Error('network unavailable')
      }
    })
    await expect(
      runReviewMethod(
        'mobileWeb.review.query',
        { ...REVIEW_IDENTITY, provider: 'github', reviewNumber: 42, query: 'assignableUsers' },
        f.context
      )
    ).rejects.toThrow('conflict')
  })

  it('refuses a review the branch lookup no longer names', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ number: 7 })
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.query',
        { ...REVIEW_IDENTITY, provider: 'github', reviewNumber: 42, query: 'assignableUsers' },
        f.context
      )
    ).rejects.toThrow('conflict')
  })
})
