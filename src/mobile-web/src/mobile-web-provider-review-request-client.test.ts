import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const HEAD = 'b'.repeat(40)

describe('mobile web provider review request client', () => {
  it('requests a provider-neutral review and rejects mismatched repository identity', async () => {
    const harness = createHarness()
    const request = harness.client.providerReview({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'provider',
      operation: 'review',
      payload: {
        workspaceId: 'repo-1::/workspace',
        expectedHead: HEAD,
        expectedBranch: 'feature/review'
      }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        observedHead: 'c'.repeat(40),
        branch: 'feature/review',
        review: null
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('validates provider review mutation identity', async () => {
    const harness = createHarness()
    const request = harness.client.providerMutateReview({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'gitlab',
      reviewNumber: 42,
      action: 'comment',
      body: 'Looks good.'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'provider',
      operation: 'mutateReview',
      payload: { provider: 'gitlab', reviewNumber: 42, action: 'comment' }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        provider: 'github',
        reviewNumber: 42,
        action: 'comment',
        outcome: 'completed'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('binds provider management responses to the requested action', async () => {
    const harness = createHarness()
    const request = harness.client.providerManageReview({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      action: 'setState',
      state: 'closed'
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'provider',
      operation: 'manageReview',
      payload: { provider: 'github', reviewNumber: 42, action: 'setState', state: 'closed' }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        provider: 'github',
        reviewNumber: 42,
        action: 'merge',
        outcome: 'completed'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('binds provider query responses to the requested query', async () => {
    const harness = createHarness()
    const request = harness.client.providerReviewQuery({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      query: 'assignableUsers'
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        provider: 'github',
        reviewNumber: 42,
        query: 'checkDetails',
        details: null
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('binds generated review fields to the requested workspace', async () => {
    const harness = createHarness()
    const request = harness.client.providerReviewGenerateFields({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      base: 'main',
      title: 'Draft',
      body: '',
      draft: false
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-2::/workspace',
        success: false,
        error: 'Wrong workspace'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('requests a dedicated review diff and rejects mismatched provider identity', async () => {
    const harness = createHarness()
    const request = harness.client.providerReviewDiff({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      expectedReviewHead: 'c'.repeat(40),
      path: 'src/review.ts',
      offset: 0,
      limit: 96
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'provider',
      operation: 'reviewDiff',
      payload: {
        provider: 'github',
        reviewNumber: 42,
        expectedReviewHead: 'c'.repeat(40),
        path: 'src/review.ts'
      }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        observedHead: HEAD,
        branch: 'feature/review',
        provider: 'gitlab',
        reviewNumber: 42,
        reviewHead: 'c'.repeat(40),
        path: 'src/review.ts',
        kind: 'binary'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('rejects a review diff page with a stale requested revision', async () => {
    const harness = createHarness()
    const request = harness.client.providerReviewDiff({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'gitlab',
      reviewNumber: 42,
      expectedReviewHead: 'c'.repeat(40),
      path: 'src/review.ts',
      offset: 96,
      limit: 96,
      expectedRevision: 'd'.repeat(64)
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        observedHead: HEAD,
        branch: 'feature/review',
        provider: 'gitlab',
        reviewNumber: 42,
        reviewHead: 'c'.repeat(40),
        path: 'src/review.ts',
        kind: 'text',
        revision: 'e'.repeat(64),
        offset: 96,
        totalRows: 100,
        rows: [],
        nextOffset: null,
        truncated: false
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('rejects a mutation response for a different thread target', async () => {
    const harness = createHarness()
    const request = harness.client.providerMutateReview({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      action: 'setThreadResolved',
      threadId: 'thread-1',
      resolved: true
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        provider: 'github',
        reviewNumber: 42,
        action: 'setThreadResolved',
        threadId: 'thread-2',
        resolved: true,
        outcome: 'completed'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('rejects an inline mutation response for a different file or line', async () => {
    const harness = createHarness()
    const request = harness.client.providerMutateReview({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      action: 'inlineComment',
      expectedReviewHead: 'c'.repeat(40),
      path: 'src/review.ts',
      line: 12,
      body: 'Bound this target.'
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        provider: 'github',
        reviewNumber: 42,
        action: 'inlineComment',
        expectedReviewHead: 'c'.repeat(40),
        path: 'src/other.ts',
        line: 12,
        outcome: 'completed'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })

  it('binds a completed review submission to its exact head, id, verdict, and comment ids', async () => {
    const harness = createHarness()
    const request = harness.client.providerSubmitReview({
      workspaceId: 'repo-1::/workspace',
      expectedHead: HEAD,
      expectedBranch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      expectedReviewHead: 'c'.repeat(40),
      submissionId: 'submission_1234567890',
      action: 'approve',
      summary: '',
      comments: [
        {
          id: 'comment_1234567890',
          path: 'src/review.ts',
          line: 12,
          body: 'Bound this target.'
        }
      ]
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'provider',
      operation: 'submitReview',
      payload: {
        provider: 'github',
        submissionId: 'submission_1234567890',
        action: 'approve'
      }
    })
    harness.client.receive(
      response('A'.repeat(22), {
        workspaceId: 'repo-1::/workspace',
        provider: 'github',
        reviewNumber: 42,
        expectedReviewHead: 'c'.repeat(40),
        submissionId: 'submission_1234567890',
        action: 'approve',
        submittedCommentIds: ['comment_0000000000'],
        outcome: 'completed'
      })
    )
    await expect(request).rejects.toMatchObject({ code: 'invalid_message', retryable: false })
  })
})

function createHarness() {
  const messages: MobileWebBridgePageMessage[] = []
  const limits = {
    maxRequestBytes: 16 * 1024,
    maxResponseBytes: 192 * 1024,
    maxConcurrent: 2,
    rateCapacity: 8,
    rateRefillPerSecond: 2
  }
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      { capability: 'provider', operation: 'review', limits },
      { capability: 'provider', operation: 'reviewCreationEligibility', limits },
      { capability: 'provider', operation: 'reviewCreate', limits },
      { capability: 'provider', operation: 'reviewGenerateFields', limits },
      { capability: 'provider', operation: 'reviewDiff', limits },
      { capability: 'provider', operation: 'reviewQuery', limits },
      { capability: 'provider', operation: 'mutateReview', limits },
      { capability: 'provider', operation: 'manageReview', limits },
      { capability: 'provider', operation: 'submitReview', limits }
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => 'A'.repeat(22)
  })
  return { client, messages }
}

function response(requestId: string, payload: unknown): MobileWebBridgeShellMessage {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId,
    status: 'success',
    payload
  }
}
