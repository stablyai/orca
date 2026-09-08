import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebProviderReviewCreationRequestClient } from './mobile-web-provider-review-creation-request-client'
import { MobileWebProviderReviewRequestClient } from './mobile-web-provider-review-request-client'

const WORKSPACE = 'repo-1::/workspace'
const HEAD = 'b'.repeat(40)
const REVIEW_HEAD = 'c'.repeat(40)
const IDENTITY = { workspaceId: WORKSPACE, expectedHead: HEAD, expectedBranch: 'feature/review' }

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  const requests = { request } as unknown as MobileWebOneShotRequestClient
  return {
    request,
    review: new MobileWebProviderReviewRequestClient(requests),
    creation: new MobileWebProviderReviewCreationRequestClient(requests)
  }
}

function expectHostRequest(
  request: ReturnType<typeof vi.fn>,
  method: string,
  params: Record<string, unknown>
) {
  expect(request).toHaveBeenCalledWith(
    'workspace',
    'hostRequest',
    { method, workspaceId: WORKSPACE, params },
    expect.anything(),
    expect.anything(),
    undefined
  )
}

describe('host-projected provider review requests', () => {
  it('reads a review through the generic lane without naming the host worktree', async () => {
    const f = fixture({ observedHead: HEAD, branch: 'feature/review', review: null })
    await expect(f.review.review(IDENTITY)).resolves.toEqual({
      workspaceId: WORKSPACE,
      observedHead: HEAD,
      branch: 'feature/review',
      review: null
    })
    expectHostRequest(f.request, 'mobileWeb.review.read', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review'
    })
  })

  it('rejects a review answered for another repository identity', async () => {
    const f = fixture({ observedHead: 'd'.repeat(40), branch: 'feature/review', review: null })
    await expect(f.review.review(IDENTITY)).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('rejects a review result the page contract does not accept', async () => {
    const f = fixture({ observedHead: HEAD, branch: 'feature/review' })
    await expect(f.review.review(IDENTITY)).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('rejects a payload the page contract does not accept before any request', async () => {
    const f = fixture(null)
    await expect(f.review.review({ ...IDENTITY, expectedHead: 'nope' })).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(f.request).not.toHaveBeenCalled()
  })

  it('sends a conversation comment mutation and echoes its action', async () => {
    const mutation = {
      ...IDENTITY,
      provider: 'gitlab' as const,
      reviewNumber: 42,
      action: 'comment' as const,
      body: 'Looks good.'
    }
    const f = fixture({
      provider: 'gitlab',
      reviewNumber: 42,
      action: 'comment',
      outcome: 'completed'
    })
    await expect(f.review.mutateReview(mutation)).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      action: 'comment'
    })
    expectHostRequest(f.request, 'mobileWeb.review.comment', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'gitlab',
      reviewNumber: 42,
      action: 'comment',
      body: 'Looks good.'
    })
  })

  it('rejects a thread mutation answered for another thread', async () => {
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      action: 'setThreadResolved',
      threadId: 'thread-2',
      resolved: true,
      outcome: 'completed'
    })
    await expect(
      f.review.mutateReview({
        ...IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'setThreadResolved',
        threadId: 'thread-1',
        resolved: true
      })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('sends a management action and echoes it back', async () => {
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      action: 'merge',
      outcome: 'completed'
    })
    await expect(
      f.review.manageReview({
        ...IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        action: 'merge',
        method: 'squash'
      })
    ).resolves.toMatchObject({ workspaceId: WORKSPACE, action: 'merge' })
    expectHostRequest(f.request, 'mobileWeb.review.manage', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      action: 'merge',
      method: 'squash'
    })
  })

  it('rejects a management answer for another action', async () => {
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      action: 'setState',
      outcome: 'completed'
    })
    await expect(
      f.review.manageReview({ ...IDENTITY, provider: 'github', reviewNumber: 42, action: 'merge' })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('sends a check-details query and binds the answer to it', async () => {
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      query: 'assignableUsers',
      users: [{ login: 'ada', name: null }]
    })
    await expect(
      f.review.reviewQuery({
        ...IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        query: 'assignableUsers'
      })
    ).resolves.toMatchObject({ workspaceId: WORKSPACE, users: [{ login: 'ada', name: null }] })
    expectHostRequest(f.request, 'mobileWeb.review.query', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      query: 'assignableUsers'
    })
  })

  it('rejects a query answered for a different query', async () => {
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      query: 'checkDetails',
      details: null
    })
    await expect(
      f.review.reviewQuery({
        ...IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        query: 'assignableUsers'
      })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('pages a review diff and rejects a stale requested revision', async () => {
    const diffPayload = {
      ...IDENTITY,
      provider: 'github' as const,
      reviewNumber: 42,
      expectedReviewHead: REVIEW_HEAD,
      path: 'src/app.ts',
      offset: 0,
      limit: 2,
      expectedRevision: 'e'.repeat(64)
    }
    const page = {
      observedHead: HEAD,
      branch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      reviewHead: REVIEW_HEAD,
      path: 'src/app.ts',
      kind: 'text',
      revision: 'e'.repeat(64),
      offset: 0,
      totalRows: 1,
      rows: [{ index: 0, kind: 'add', text: 'hi', textTruncated: false, newLineNumber: 1 }],
      nextOffset: null,
      truncated: false
    }
    const accepted = fixture(page)
    await expect(accepted.review.reviewDiff(diffPayload)).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      kind: 'text'
    })
    expectHostRequest(accepted.request, 'mobileWeb.review.diff', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      expectedReviewHead: REVIEW_HEAD,
      path: 'src/app.ts',
      offset: 0,
      limit: 2,
      expectedRevision: 'e'.repeat(64)
    })

    const stale = fixture({ ...page, revision: 'f'.repeat(64) })
    await expect(stale.review.reviewDiff(diffPayload)).rejects.toMatchObject({
      code: 'invalid_message'
    })
  })

  it('submits a queued review and binds the answer to its comment ids', async () => {
    const submission = {
      ...IDENTITY,
      provider: 'github' as const,
      reviewNumber: 42,
      expectedReviewHead: REVIEW_HEAD,
      submissionId: 'submission_1234567890',
      action: 'approve' as const,
      summary: 'Ship it.',
      comments: []
    }
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      expectedReviewHead: REVIEW_HEAD,
      submissionId: 'submission_1234567890',
      action: 'approve',
      submittedCommentIds: [],
      outcome: 'completed'
    })
    await expect(f.review.submitReview(submission)).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      action: 'approve'
    })
    expectHostRequest(f.request, 'mobileWeb.review.submit', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      expectedReviewHead: REVIEW_HEAD,
      submissionId: 'submission_1234567890',
      action: 'approve',
      summary: 'Ship it.',
      comments: []
    })
  })

  it('rejects a submission answered for another queued comment set', async () => {
    const f = fixture({
      provider: 'github',
      reviewNumber: 42,
      expectedReviewHead: REVIEW_HEAD,
      submissionId: 'submission_1234567890',
      action: 'approve',
      submittedCommentIds: ['comment_0000000000'],
      outcome: 'completed'
    })
    await expect(
      f.review.submitReview({
        ...IDENTITY,
        provider: 'github',
        reviewNumber: 42,
        expectedReviewHead: REVIEW_HEAD,
        submissionId: 'submission_1234567890',
        action: 'approve',
        summary: 'Ship it.',
        comments: []
      })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('reads creation eligibility and binds it to the repository identity', async () => {
    const f = fixture({
      observedHead: HEAD,
      branch: 'feature/review',
      provider: 'github',
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'not_found'
    })
    await expect(f.creation.eligibility({ ...IDENTITY, base: 'main' })).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      canCreate: true
    })
    expectHostRequest(f.request, 'mobileWeb.review.creationEligibility', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      base: 'main'
    })
  })

  it('creates a review and rejects an answer from another provider', async () => {
    const create = {
      ...IDENTITY,
      provider: 'github' as const,
      base: 'main',
      title: 'Add review lane',
      body: '',
      draft: false
    }
    const accepted = fixture({
      provider: 'github',
      ok: true,
      number: 42,
      url: 'https://github.example/acme/orca/pull/42'
    })
    await expect(accepted.creation.create(create)).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      number: 42
    })
    expectHostRequest(accepted.request, 'mobileWeb.review.create', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      base: 'main',
      title: 'Add review lane',
      body: '',
      draft: false
    })

    const mismatched = fixture({
      provider: 'gitlab',
      ok: true,
      number: 42,
      url: 'https://github.example/acme/orca/pull/42'
    })
    await expect(mismatched.creation.create(create)).rejects.toMatchObject({
      code: 'invalid_message'
    })
  })

  it('generates review fields for the requested workspace', async () => {
    const f = fixture({
      success: true,
      fields: { base: 'main', title: 'Generated', body: 'Body', draft: false }
    })
    await expect(
      f.creation.generateFields({
        ...IDENTITY,
        base: 'main',
        title: '',
        body: '',
        draft: false
      })
    ).resolves.toMatchObject({ workspaceId: WORKSPACE, success: true })
    expectHostRequest(f.request, 'mobileWeb.review.generateFields', {
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      base: 'main',
      title: '',
      body: '',
      draft: false
    })
  })
})
