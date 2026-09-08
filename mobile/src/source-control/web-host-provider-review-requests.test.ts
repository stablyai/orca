import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSourceControlClient } from './web-host-source-control-client'

const WORKSPACE_ID = 'workspace-page-1'
const HEAD = 'a'.repeat(40)

describe('web host provider review requests', () => {
  it('probes GitHub repository eligibility without requiring an existing review', async () => {
    const bridge = bridgeClient()
    bridge.providerReview.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'main',
      review: null
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const response = await client.sendRequest('github.repoSlug', {})

    expect(response).toMatchObject({
      ok: true,
      result: { owner: 'paired-host', repo: 'workspace' }
    })
    expect(bridge.providerReview).not.toHaveBeenCalled()
    expect(bridge.providerReviewCreationEligibility).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main'
    })
  })

  it('coalesces the PR chip and creation-action eligibility probes', async () => {
    const bridge = bridgeClient()
    bridge.providerReviewCreationEligibility.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'main',
      provider: 'github',
      review: null,
      canCreate: false,
      blockedReason: 'auth_required',
      nextAction: 'authenticate',
      reviewLookupOutcome: 'unavailable'
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const [slug, eligibility] = await Promise.all([
      client.sendRequest('github.repoSlug', {}),
      client.sendRequest('hostedReview.getCreationEligibility', {})
    ])

    expect(slug).toMatchObject({
      ok: true,
      result: { owner: 'paired-host', repo: 'workspace' }
    })
    expect(eligibility).toMatchObject({
      ok: true,
      result: { provider: 'github', blockedReason: 'auth_required' }
    })
    expect(bridge.sourceControlStatus).toHaveBeenCalledTimes(1)
    expect(bridge.providerReviewCreationEligibility).toHaveBeenCalledTimes(1)

    const review = await client.sendRequest('hostedReview.forBranch', {
      branch: 'main'
    })

    expect(review).toMatchObject({ ok: true, result: null })
    await expect(client.sendRequest('github.prForBranch', {})).resolves.toMatchObject({
      ok: true,
      result: null
    })
    expect(bridge.sourceControlStatus).toHaveBeenCalledTimes(1)
    expect(bridge.providerReview).not.toHaveBeenCalled()
  })

  it('projects one provider review into the unchanged PR presentation', async () => {
    const bridge = bridgeClient()
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const pr = await client.sendRequest('github.prForBranch', {
      branch: 'main'
    })
    const details = await client.sendRequest('github.workItemDetails', {
      number: 7
    })

    expect(pr.ok && pr.result).toMatchObject({
      number: 7,
      title: 'Ship hosted Source Control',
      state: 'open',
      headSha: HEAD
    })
    expect(details.ok && details.result).toMatchObject({
      body: 'Review body',
      comments: [
        {
          id: 1,
          author: 'reviewer',
          body: 'Please adjust this',
          threadId: 'thread-1'
        }
      ]
    })
    expect(bridge.providerReview).toHaveBeenCalledTimes(1)
  })

  it('maps retained review replies through exact provider identity', async () => {
    const bridge = bridgeClient()
    bridge.providerMutateReview.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      reviewNumber: 7,
      outcome: 'completed',
      action: 'reply',
      commentId: 'comment-1',
      threadId: 'thread-1'
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )
    await client.sendRequest('github.workItemDetails', { number: 7 })

    const response = await client.sendRequest('github.addPRReviewCommentReply', {
      prNumber: 7,
      commentId: 1,
      threadId: 'thread-1',
      body: 'Updated'
    })

    expect(response.ok).toBe(true)
    expect(bridge.providerMutateReview).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main',
      provider: 'github',
      reviewNumber: 7,
      action: 'reply',
      commentId: 'comment-1',
      threadId: 'thread-1',
      body: 'Updated'
    })
  })

  it('maps unchanged PR management calls without forwarding page repository identity', async () => {
    const bridge = bridgeClient()
    bridge.providerManageReview.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      reviewNumber: 7,
      action: 'updateConversationComment',
      outcome: 'completed'
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )
    await client.sendRequest('github.workItemDetails', { number: 7 })

    const response = await client.sendRequest('github.project.updateIssueCommentBySlug', {
      owner: 'page-controlled',
      repo: 'other',
      commentId: 1,
      body: 'Updated'
    })

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(bridge.providerManageReview).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main',
      provider: 'github',
      reviewNumber: 7,
      action: 'updateConversationComment',
      commentId: 'comment-1',
      body: 'Updated'
    })
    expect(JSON.stringify(bridge.providerManageReview.mock.calls)).not.toContain('page-controlled')
  })

  it('loads assignable users through the bounded provider query', async () => {
    const bridge = bridgeClient()
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )
    const response = await client.sendRequest('github.listAssignableUsers', {})

    expect(response).toMatchObject({
      ok: true,
      result: [{ login: 'ada', name: 'Ada', avatarUrl: '' }]
    })
    expect(bridge.providerReviewQuery).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main',
      provider: 'github',
      reviewNumber: 7,
      query: 'assignableUsers'
    })
  })
})

function bridgeClient() {
  return {
    sourceControlStatus: vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      branch: 'main',
      head: HEAD,
      conflictOperation: 'unknown',
      entries: [],
      totalCount: 0,
      truncated: false
    }),
    providerReview: vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'main',
      review: {
        provider: 'github',
        number: 7,
        title: 'Ship hosted Source Control',
        state: 'open',
        checksStatus: 'success',
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        updatedAt: '2026-07-27T12:00:00Z',
        headSha: HEAD,
        body: 'Review body',
        comments: [
          {
            id: 'comment-1',
            author: 'reviewer',
            body: 'Please adjust this',
            createdAt: '2026-07-27T12:00:00Z',
            kind: 'inline',
            path: 'src/app.ts',
            line: 4,
            threadId: 'thread-1',
            threadState: 'open',
            allowedActions: ['reply', 'set-resolved']
          }
        ],
        commentsTruncated: false,
        files: [],
        filesTruncated: false,
        author: null,
        reviewRequests: [],
        latestReviews: [],
        checks: [],
        detailsState: 'loaded',
        canComment: true,
        allowedSubmissionActions: ['comment']
      }
    }),
    providerReviewCreationEligibility: vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'main',
      provider: 'github',
      review: null,
      canCreate: false,
      blockedReason: 'dirty',
      nextAction: 'commit',
      reviewLookupOutcome: 'not_found'
    }),
    providerMutateReview: vi.fn(),
    providerManageReview: vi.fn(),
    providerReviewQuery: vi.fn().mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      reviewNumber: 7,
      query: 'assignableUsers',
      users: [{ login: 'ada', name: 'Ada' }]
    })
  }
}
