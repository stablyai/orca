import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const HOST_WORKSPACE_ID = 'repo-1::/private/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, HOST_WORKSPACE_ID)

describe('mobile web provider review creation', () => {
  it('derives eligibility state from fresh shell-owned repository data', async () => {
    const client = rpcClient()
    const result = await executeMobileWebProviderOperation({
      operation: 'reviewCreationEligibility',
      payload: {
        workspaceId: WORKSPACE_ID,
        expectedHead: HEAD,
        expectedBranch: 'feature/review',
        base: 'main'
      },
      client,
      workspaceAuthority
    })

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      canCreate: true,
      reviewLookupOutcome: 'not_found'
    })
    expect(client.sendRequest).toHaveBeenCalledWith('hostedReview.getCreationEligibility', {
      repo: 'id:repo-1',
      worktree: `id:${HOST_WORKSPACE_ID}`,
      branch: 'feature/review',
      base: 'main',
      hasUncommittedChanges: true,
      hasUpstream: true,
      ahead: 1,
      behind: 0,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
  })

  it('rechecks eligibility immediately before creating a review', async () => {
    const client = rpcClient()
    const result = await executeMobileWebProviderOperation({
      operation: 'reviewCreate',
      payload: {
        workspaceId: WORKSPACE_ID,
        expectedHead: HEAD,
        expectedBranch: 'feature/review',
        provider: 'github',
        base: 'main',
        head: 'feature/review',
        title: 'Ship the bridge',
        body: 'Description',
        draft: false
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('hostedReview.create', {
      repo: 'id:repo-1',
      worktree: `id:${HOST_WORKSPACE_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/review',
      title: 'Ship the bridge',
      body: 'Description',
      draft: false
    })
    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      ok: true,
      number: 17,
      url: 'https://github.example/acme/orca/pull/17'
    })
  })

  it('rejects create when fresh eligibility no longer authorizes it', async () => {
    const client = rpcClient({ canCreate: false })
    await expect(
      executeMobileWebProviderOperation({
        operation: 'reviewCreate',
        payload: {
          workspaceId: WORKSPACE_ID,
          expectedHead: HEAD,
          expectedBranch: 'feature/review',
          provider: 'github',
          base: 'main',
          title: 'Stale create',
          body: '',
          draft: false
        },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(client, 'hostedReview.create')).toHaveLength(0)
  })

  it('generates bounded review fields after a fresh repository identity check', async () => {
    const client = rpcClient()
    const result = await executeMobileWebProviderOperation({
      operation: 'reviewGenerateFields',
      payload: {
        workspaceId: WORKSPACE_ID,
        expectedHead: HEAD,
        expectedBranch: 'feature/review',
        base: 'main',
        title: 'Draft',
        body: '',
        draft: false
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('git.generatePullRequestFields', {
      worktree: `id:${HOST_WORKSPACE_ID}`,
      base: 'main',
      title: 'Draft',
      body: '',
      draft: false
    })
    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      success: true,
      fields: { base: 'main', title: 'Generated title' }
    })
  })
})

function rpcClient(
  options: { canCreate?: boolean } = {}
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'git.status') {
      return {
        ok: true,
        result: {
          head: HEAD,
          branch: 'feature/review',
          conflictOperation: 'unknown',
          entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]
        }
      }
    }
    if (method === 'git.upstreamStatus') {
      return {
        ok: true,
        result: {
          hasUpstream: true,
          upstreamName: 'origin/feature/review',
          ahead: 1,
          behind: 0,
          hasConfiguredPushTarget: true,
          behindCommitsArePatchEquivalent: false
        }
      }
    }
    if (method === 'worktree.show') {
      return {
        ok: true,
        result: {
          worktree: {
            baseRef: 'main',
            linkedPR: null,
            linkedGitLabMR: null
          }
        }
      }
    }
    if (method === 'hostedReview.getCreationEligibility') {
      return {
        ok: true,
        result: {
          provider: 'github',
          review: null,
          canCreate: options.canCreate ?? true,
          blockedReason: options.canCreate === false ? 'needs_sync' : null,
          nextAction: options.canCreate === false ? 'sync' : null,
          reviewLookupOutcome: 'not_found',
          defaultBaseRef: 'main',
          head: 'feature/review',
          title: 'Ship the bridge',
          body: ''
        }
      }
    }
    if (method === 'hostedReview.create') {
      return {
        ok: true,
        result: {
          ok: true,
          number: 17,
          url: 'https://github.example/acme/orca/pull/17'
        }
      }
    }
    if (method === 'git.generatePullRequestFields') {
      return {
        ok: true,
        result: {
          success: true,
          fields: {
            base: 'main',
            title: 'Generated title',
            body: 'Generated body',
            draft: false
          }
        }
      }
    }
    return { ok: false, error: { message: `Unexpected ${method}` } }
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
