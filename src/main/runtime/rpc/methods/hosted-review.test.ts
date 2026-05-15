import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { HOSTED_REVIEW_METHODS } from './hosted-review'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('hosted review RPC methods', () => {
  it('fetches branch review status on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getHostedReviewForBranch: vi.fn().mockResolvedValue({
        provider: 'github',
        number: 12,
        title: 'Feature',
        state: 'open',
        url: 'https://github.com/acme/orca/pull/12',
        status: 'success',
        updatedAt: '2026-05-10T00:00:00.000Z',
        mergeable: 'MERGEABLE'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOSTED_REVIEW_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('hostedReview.forBranch', {
        repo: 'C:\\repo',
        branch: 'feature/windows',
        linkedGitHubPR: 12
      })
    )

    expect(runtime.getHostedReviewForBranch).toHaveBeenCalledWith({
      repoSelector: 'C:\\repo',
      branch: 'feature/windows',
      linkedGitHubPR: 12,
      linkedGitLabMR: null,
      linkedBitbucketPR: null
    })
    expect(response).toMatchObject({
      ok: true,
      result: { provider: 'github', number: 12 }
    })
  })
})
