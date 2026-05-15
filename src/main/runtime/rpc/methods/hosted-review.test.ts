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
      linkedBitbucketPR: null,
      linkedGiteaPR: null
    })
    expect(response).toMatchObject({
      ok: true,
      result: { provider: 'github', number: 12 }
    })
  })

  it('dispatches creation eligibility requests to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getHostedReviewCreationEligibility: vi.fn().mockResolvedValue({
        provider: 'github',
        review: null,
        canCreate: true,
        blockedReason: null,
        nextAction: null,
        defaultBaseRef: 'main',
        head: 'feature/create-pr',
        title: 'Create PR'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOSTED_REVIEW_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('hostedReview.getCreationEligibility', {
        repo: 'repo-1',
        branch: 'feature/create-pr',
        base: 'origin/main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        linkedGitHubPR: null
      })
    )

    expect(runtime.getHostedReviewCreationEligibility).toHaveBeenCalledWith({
      repoSelector: 'repo-1',
      branch: 'feature/create-pr',
      base: 'origin/main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedGiteaPR: null
    })
    expect(response).toMatchObject({
      ok: true,
      result: { provider: 'github', canCreate: true }
    })
  })

  it('dispatches create requests to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createHostedReview: vi.fn().mockResolvedValue({
        ok: true,
        number: 51,
        url: 'https://github.com/acme/orca/pull/51'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOSTED_REVIEW_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('hostedReview.create', {
        repo: 'repo-1',
        provider: 'github',
        base: 'main',
        head: 'feature/create-pr',
        title: 'Create PR',
        body: 'Body',
        draft: true
      })
    )

    expect(runtime.createHostedReview).toHaveBeenCalledWith({
      repoSelector: 'repo-1',
      provider: 'github',
      base: 'main',
      head: 'feature/create-pr',
      title: 'Create PR',
      body: 'Body',
      draft: true
    })
    expect(response).toMatchObject({
      ok: true,
      result: { ok: true, number: 51 }
    })
  })
})
