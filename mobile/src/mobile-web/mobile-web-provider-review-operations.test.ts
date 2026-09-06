import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const HOST_WORKSPACE_ID = 'repo-1::/private/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, HOST_WORKSPACE_ID)

describe('mobile web provider review operations', () => {
  it('discovers and sanitizes a GitHub review without exposing provider URLs or avatars', async () => {
    const client = rpcClient({
      review: hostedReview('github'),
      details: {
        item: { id: 'PR_1', number: 17, type: 'pr' },
        body: 'Review body',
        comments: [
          {
            id: 9,
            author: 'ada',
            authorAvatarUrl: 'https://avatars.example/private',
            body: '<script>inert text</script>',
            createdAt: '2026-07-23T00:00:00.000Z',
            url: 'https://github.example/acme/orca/pull/17#comment-9',
            path: 'src/review.ts',
            line: 12,
            threadId: 'thread-1',
            isResolved: false
          }
        ],
        secret: 'provider-token'
      }
    })
    const result = await executeMobileWebProviderOperation({
      operation: 'review',
      payload: identity(),
      client,
      workspaceAuthority
    })

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'feature/review',
      review: {
        provider: 'github',
        number: 17,
        detailsState: 'loaded',
        canComment: true,
        comments: [
          {
            id: '9',
            kind: 'inline',
            path: 'src/review.ts',
            line: 12,
            threadState: 'open'
          }
        ]
      }
    })
    expect(JSON.stringify(result)).not.toContain('avatars.example')
    expect(JSON.stringify(result)).not.toContain('github.example')
    expect(JSON.stringify(result)).not.toContain('provider-token')
    expect(JSON.stringify(result)).not.toContain('/private/workspace')
    expect(client.sendRequest).toHaveBeenCalledWith('github.workItemDetails', {
      repo: 'id:repo-1',
      number: 17,
      type: 'pr'
    })
  })

  it('routes a GitLab conversation comment after exact repository and review preflight', async () => {
    const client = rpcClient({
      review: hostedReview('gitlab'),
      details: {
        item: {
          id: 'mr-17',
          number: 17,
          type: 'mr',
          projectRef: { host: 'gitlab.example', path: 'acme/orca' }
        },
        body: '',
        comments: []
      },
      mutation: { ok: true, comment: { id: 10 } }
    })
    const result = await executeMobileWebProviderOperation({
      operation: 'mutateReview',
      payload: {
        ...identity(),
        provider: 'gitlab',
        reviewNumber: 17,
        action: 'comment',
        body: '  Please verify the SSH path.  '
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'git.status', {
      worktree: `id:${HOST_WORKSPACE_ID}`
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'hostedReview.forBranch', {
      repo: 'id:repo-1',
      branch: 'feature/review',
      currentHeadOid: HEAD
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'gitlab.workItemDetails', {
      repo: 'id:repo-1',
      iid: 17,
      type: 'mr'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(4, 'git.status', {
      worktree: `id:${HOST_WORKSPACE_ID}`
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(5, 'gitlab.addMRComment', {
      repo: 'id:repo-1',
      iid: 17,
      body: 'Please verify the SSH path.',
      projectRef: { host: 'gitlab.example', path: 'acme/orca' }
    })
    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      provider: 'gitlab',
      reviewNumber: 17,
      action: 'comment',
      outcome: 'completed'
    })
  })

  it('revalidates a GitHub thread before replying with native-only provider identity', async () => {
    const details = githubDetails()
    const client = rpcClient({
      review: hostedReview('github'),
      details,
      mutation: { ok: true, comment: { id: 11 } }
    })
    const result = await executeMobileWebProviderOperation({
      operation: 'mutateReview',
      payload: {
        ...identity(),
        provider: 'github',
        reviewNumber: 17,
        action: 'reply',
        commentId: '9',
        threadId: 'thread-1',
        body: 'Reply from the paired shell.'
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('github.addPRReviewCommentReply', {
      repo: 'id:repo-1',
      prNumber: 17,
      commentId: 9,
      threadId: 'thread-1',
      body: 'Reply from the paired shell.',
      path: 'src/review.ts',
      line: 12,
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
    expect(result).toMatchObject({
      action: 'reply',
      commentId: '9',
      threadId: 'thread-1',
      outcome: 'completed'
    })

    const staleComment = rpcClient({
      review: hostedReview('github'),
      details
    })
    await expect(
      executeMobileWebProviderOperation({
        operation: 'mutateReview',
        payload: {
          ...identity(),
          provider: 'github',
          reviewNumber: 17,
          action: 'reply',
          commentId: '10',
          threadId: 'thread-1',
          body: 'Wrong target'
        },
        client: staleComment,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(staleComment, 'github.addPRReviewCommentReply')).toHaveLength(0)
  })

  it('resolves a GitHub thread through its exact provider repository', async () => {
    const client = rpcClient({
      review: hostedReview('github'),
      details: githubDetails(),
      mutation: true
    })
    await executeMobileWebProviderOperation({
      operation: 'mutateReview',
      payload: {
        ...identity(),
        provider: 'github',
        reviewNumber: 17,
        action: 'setThreadResolved',
        threadId: 'thread-1',
        resolved: true
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenLastCalledWith('github.resolveReviewThread', {
      repo: 'id:repo-1',
      threadId: 'thread-1',
      resolve: true,
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
  })

  it('resolves a GitLab discussion and treats the requested state as idempotent', async () => {
    const details = gitLabDetails(false)
    const client = rpcClient({
      review: hostedReview('gitlab'),
      details,
      mutation: { ok: true }
    })
    await executeMobileWebProviderOperation({
      operation: 'mutateReview',
      payload: {
        ...identity(),
        provider: 'gitlab',
        reviewNumber: 17,
        action: 'setThreadResolved',
        threadId: 'discussion-1',
        resolved: true
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenLastCalledWith('gitlab.resolveMRDiscussion', {
      repo: 'id:repo-1',
      iid: 17,
      discussionId: 'discussion-1',
      resolved: true,
      projectRef: { host: 'gitlab.example', path: 'acme/orca' }
    })

    const alreadyResolved = rpcClient({
      review: hostedReview('gitlab'),
      details: gitLabDetails(true)
    })
    await executeMobileWebProviderOperation({
      operation: 'mutateReview',
      payload: {
        ...identity(),
        provider: 'gitlab',
        reviewNumber: 17,
        action: 'setThreadResolved',
        threadId: 'discussion-1',
        resolved: true
      },
      client: alreadyResolved,
      workspaceAuthority
    })
    expect(callsFor(alreadyResolved, 'gitlab.resolveMRDiscussion')).toHaveLength(0)
  })

  it('rejects stale repository or review identity before a provider mutation', async () => {
    const staleHead = rpcClient({ head: 'b'.repeat(40), review: hostedReview('github') })
    await expect(
      executeMobileWebProviderOperation({
        operation: 'mutateReview',
        payload: {
          ...identity(),
          provider: 'github',
          reviewNumber: 17,
          action: 'comment',
          body: 'Comment'
        },
        client: staleHead,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(staleHead, 'github.addIssueComment')).toHaveLength(0)

    const changedReview = rpcClient({
      review: { ...hostedReview('github'), number: 18 }
    })
    await expect(
      executeMobileWebProviderOperation({
        operation: 'mutateReview',
        payload: {
          ...identity(),
          provider: 'github',
          reviewNumber: 17,
          action: 'comment',
          body: 'Comment'
        },
        client: changedReview,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(changedReview, 'github.addIssueComment')).toHaveLength(0)
  })

  it('keeps unsupported-provider details and mutations explicitly unavailable', async () => {
    const client = rpcClient({ review: hostedReview('bitbucket') })
    const result = await executeMobileWebProviderOperation({
      operation: 'review',
      payload: identity(),
      client,
      workspaceAuthority
    })
    expect(result).toMatchObject({
      review: {
        provider: 'bitbucket',
        detailsState: 'unsupported',
        canComment: false,
        comments: []
      }
    })
    expect(callsFor(client, 'github.workItemDetails')).toHaveLength(0)
    expect(callsFor(client, 'gitlab.workItemDetails')).toHaveLength(0)
  })

  it('does not attach details returned for a different review identity', async () => {
    const client = rpcClient({
      review: hostedReview('gitlab'),
      details: {
        item: { id: 'mr-18', number: 18, type: 'mr' },
        body: 'Wrong review',
        comments: [{ id: 1, author: 'mallory', body: 'Wrong comments', createdAt: '' }]
      }
    })
    const result = await executeMobileWebProviderOperation({
      operation: 'review',
      payload: identity(),
      client,
      workspaceAuthority
    })

    expect(result).toMatchObject({
      review: { number: 17, detailsState: 'unavailable', canComment: false, comments: [] }
    })
    expect(JSON.stringify(result)).not.toContain('Wrong review')
  })

  it('keeps the maximum retained conversation inside the negotiated response budget', async () => {
    const client = rpcClient({
      review: hostedReview('github'),
      details: {
        item: { id: 'PR_1', number: 17, type: 'pr' },
        body: 'b'.repeat(40 * 1024),
        comments: Array.from({ length: 40 }, (_, index) => ({
          id: index + 1,
          author: 'reviewer',
          body: 'c'.repeat(5 * 1024),
          createdAt: '2026-07-23T00:00:00.000Z'
        }))
      }
    })
    const result = await executeMobileWebProviderOperation({
      operation: 'review',
      payload: identity(),
      client,
      workspaceAuthority
    })

    if (!('review' in result) || !result.review) {
      throw new Error('Expected provider review')
    }
    expect(result.review.comments).toHaveLength(32)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      192 * 1024
    )
  })
})

function identity() {
  return {
    workspaceId: WORKSPACE_ID,
    expectedHead: HEAD,
    expectedBranch: 'feature/review'
  }
}

function hostedReview(provider: 'github' | 'gitlab' | 'bitbucket') {
  return {
    provider,
    number: 17,
    title: 'Provider-neutral review',
    state: 'open',
    url: 'https://provider.example/review/17',
    status: 'success',
    updatedAt: '2026-07-23T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    headSha: HEAD
  }
}

function githubDetails() {
  return {
    item: {
      id: 'PR_1',
      number: 17,
      type: 'pr',
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    },
    body: '',
    comments: [
      {
        id: 9,
        author: 'ada',
        body: 'Thread root',
        createdAt: '2026-07-23T00:00:00.000Z',
        path: 'src/review.ts',
        line: 12,
        threadId: 'thread-1',
        isResolved: false
      }
    ]
  }
}

function gitLabDetails(resolved: boolean) {
  return {
    item: {
      id: 'mr-17',
      number: 17,
      type: 'mr',
      projectRef: { host: 'gitlab.example', path: 'acme/orca' }
    },
    body: '',
    comments: [
      {
        id: 10,
        author: 'grace',
        body: 'Discussion root',
        createdAt: '2026-07-23T00:00:00.000Z',
        path: 'src/review.ts',
        line: 14,
        threadId: 'discussion-1',
        isResolved: resolved
      }
    ]
  }
}

function rpcClient(
  options: {
    head?: string
    review?: unknown
    details?: unknown
    mutation?: unknown
  } = {}
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'git.status') {
      return {
        ok: true,
        result: {
          head: options.head ?? HEAD,
          branch: 'feature/review',
          conflictOperation: 'unknown'
        }
      }
    }
    if (method === 'hostedReview.forBranch') {
      return { ok: true, result: options.review ?? null }
    }
    if (method === 'github.workItemDetails' || method === 'gitlab.workItemDetails') {
      return { ok: true, result: options.details ?? null }
    }
    if (
      method === 'github.addIssueComment' ||
      method === 'github.addPRReviewCommentReply' ||
      method === 'gitlab.addMRComment' ||
      method === 'gitlab.resolveMRDiscussion'
    ) {
      return { ok: true, result: options.mutation ?? { ok: true, comment: { id: 1 } } }
    }
    if (method === 'github.resolveReviewThread') {
      return { ok: true, result: options.mutation ?? true }
    }
    return { ok: false, error: { message: `Unexpected ${method}` } }
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
