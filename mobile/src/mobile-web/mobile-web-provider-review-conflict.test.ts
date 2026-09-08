import { describe, expect, it, vi } from 'vitest'
import { hostedSourceControlResponse } from '../source-control/web-host-source-control-response'
import { mapDispatcherError } from '../../../src/main/runtime/rpc/dispatcher-error-response'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS } from '../../../src/main/runtime/rpc/methods/mobile-web-source-control-review-metadata'
import {
  REVIEW_IDENTITY,
  reviewRuntime,
  reviewStatus,
  runReviewMethod
} from '../../../src/main/runtime/rpc/methods/mobile-web-review-test-fixture'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import type { RpcClient } from '../transport/rpc-client'

const CONFLICT_COPY = 'This review changed on the host. Refresh the review before saving again.'

async function fixture(failure?: Error) {
  const runtime = reviewRuntime({
    getRuntimeGitStatus: reviewStatus({ head: 'c'.repeat(40) }),
    showManagedWorktree: { diffComments: [], mobileDiffReview: undefined }
  })
  const sendRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'worktree.ps') {
      return {
        ok: true as const,
        result: {
          worktrees: [{ worktreeId: 'host-workspace', repo: '/repo', displayName: 'Workspace' }]
        }
      }
    }
    try {
      if (failure) {
        throw failure
      }
      if (method === 'mobileWeb.sourceControl.reviewMetadataUpdate') {
        const entry = MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS[1]!
        await entry.handler(entry.params!.parse(params), runtime.context)
      } else {
        await runReviewMethod(method, params, runtime.context)
      }
      throw new Error('Expected stale write to fail')
    } catch (error) {
      return mapDispatcherError({ id: 'request', method, params }, { runtimeId: 'host' }, error)
    }
  })
  const bridge = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS,
    rpcClient: { sendRequest } as unknown as RpcClient
  })
  const snapshot = await bridge.client.workspaceSnapshot({ limit: 10 })
  return { ...bridge, workspaceId: snapshot.workspaces[0]!.id }
}

describe('review write conflicts across the desktop, shell and page', () => {
  it.each(['metadata', 'comment', 'approve'] as const)(
    'keeps a stale %s write distinguishable and readable by the review screen',
    async (action) => {
      const { client, workspaceId, shellMessages } = await fixture()
      const identity = {
        ...REVIEW_IDENTITY,
        workspaceId,
        provider: 'github' as const,
        reviewNumber: 42
      }
      const pending =
        action === 'metadata'
          ? client.sourceControlReviewMetadataUpdate({
              workspaceId,
              expectedRevision: 'b'.repeat(64),
              comments: [],
              reviewState: { version: 1, files: [] }
            })
          : action === 'comment'
            ? client.providerMutateReview({ ...identity, action, body: 'Looks good.' })
            : client.providerSubmitReview({
                ...identity,
                action,
                expectedReviewHead: 'b'.repeat(40),
                submissionId: 'submission_1234567890',
                summary: 'Ship it.',
                comments: []
              })
      await expect(pending).rejects.toMatchObject({
        code: 'conflict',
        retryable: false,
        message: CONFLICT_COPY
      })
      await expect(hostedSourceControlResponse(() => pending)).resolves.toMatchObject({
        ok: false,
        error: { code: 'conflict', message: CONFLICT_COPY }
      })
      expect(shellMessages).toContainEqual(
        expect.objectContaining({
          type: 'response',
          error: expect.objectContaining({ code: 'conflict', retryable: false })
        })
      )
    }
  )

  it('keeps other desktop failures retryable', async () => {
    const { client, workspaceId } = await fixture(new Error('Provider unavailable'))
    await expect(
      client.providerMutateReview({
        ...REVIEW_IDENTITY,
        workspaceId,
        provider: 'gitlab',
        reviewNumber: 42,
        action: 'comment',
        body: 'Hello'
      })
    ).rejects.toMatchObject({ code: 'host_error', retryable: true, message: 'host_error' })
  })
})
