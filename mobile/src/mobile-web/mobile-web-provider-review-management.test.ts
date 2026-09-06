import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const HOST_WORKSPACE_ID = 'repo-1::/private/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, HOST_WORKSPACE_ID)

describe('mobile web provider review management', () => {
  it('revalidates review identity and derives the GitHub merge target natively', async () => {
    const client = rpcClient()
    const result = await executeMobileWebProviderOperation({
      operation: 'manageReview',
      payload: { ...identity(), action: 'merge', method: 'squash' },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('github.mergePR', {
      repo: 'id:repo-1',
      prNumber: 17,
      method: 'squash',
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      reviewNumber: 17,
      action: 'merge',
      outcome: 'completed'
    })
  })

  it('requires every requested reviewer to remain assignable', async () => {
    const client = rpcClient({ assignable: [{ login: 'ada' }] })
    await executeMobileWebProviderOperation({
      operation: 'manageReview',
      payload: { ...identity(), action: 'requestReviewers', reviewers: ['Ada'] },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenLastCalledWith('github.requestPRReviewers', {
      repo: 'id:repo-1',
      prNumber: 17,
      reviewers: ['Ada'],
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })

    const stale = rpcClient({ assignable: [{ login: 'grace' }] })
    await expect(
      executeMobileWebProviderOperation({
        operation: 'manageReview',
        payload: { ...identity(), action: 'requestReviewers', reviewers: ['ada'] },
        client: stale,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(stale, 'github.requestPRReviewers')).toHaveLength(0)
  })

  it('binds root-comment edits to a freshly retained provider comment and slug', async () => {
    const client = rpcClient()
    await executeMobileWebProviderOperation({
      operation: 'manageReview',
      payload: {
        ...identity(),
        action: 'updateConversationComment',
        commentId: '11',
        body: 'Updated body'
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenLastCalledWith('github.project.updateIssueCommentBySlug', {
      host: 'github.example',
      owner: 'acme',
      repo: 'orca',
      commentId: 11,
      body: 'Updated body'
    })

    const stale = rpcClient()
    await expect(
      executeMobileWebProviderOperation({
        operation: 'manageReview',
        payload: { ...identity(), action: 'deleteConversationComment', commentId: '12' },
        client: stale,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(stale, 'github.project.deleteIssueCommentBySlug')).toHaveLength(0)
  })

  it('keeps GitLab management explicitly unsupported', async () => {
    const client = rpcClient({ provider: 'gitlab' })
    await expect(
      executeMobileWebProviderOperation({
        operation: 'manageReview',
        payload: {
          ...identity(),
          provider: 'gitlab',
          action: 'setState',
          state: 'closed'
        },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
    expect(callsFor(client, 'github.updatePRState')).toHaveLength(0)
  })

  it('rejects a branch change after provider preflight', async () => {
    let statusReads = 0
    const client = rpcClient({
      status: () => {
        statusReads += 1
        return statusReads === 1
          ? { head: HEAD, branch: 'feature/review', conflictOperation: 'unknown' }
          : { head: 'b'.repeat(40), branch: 'other', conflictOperation: 'unknown' }
      }
    })

    await expect(
      executeMobileWebProviderOperation({
        operation: 'manageReview',
        payload: { ...identity(), action: 'merge' },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(client, 'github.mergePR')).toHaveLength(0)
  })
})

function identity() {
  return {
    workspaceId: WORKSPACE_ID,
    expectedHead: HEAD,
    expectedBranch: 'feature/review',
    provider: 'github' as const,
    reviewNumber: 17
  }
}

function rpcClient(
  options: {
    provider?: 'github' | 'gitlab'
    assignable?: unknown[]
    status?: () => Record<string, unknown>
  } = {}
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const provider = options.provider ?? 'github'
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'git.status') {
      return {
        ok: true,
        result: options.status?.() ?? {
          head: HEAD,
          branch: 'feature/review',
          conflictOperation: 'unknown'
        }
      }
    }
    if (method === 'hostedReview.forBranch') {
      return {
        ok: true,
        result: {
          provider,
          number: 17,
          title: 'Review',
          state: 'open',
          status: 'success',
          updatedAt: '',
          mergeable: 'MERGEABLE',
          headSha: HEAD
        }
      }
    }
    if (method === 'github.workItemDetails') {
      return { ok: true, result: githubDetails() }
    }
    if (method === 'gitlab.workItemDetails') {
      return {
        ok: true,
        result: {
          item: {
            id: 'MR_17',
            number: 17,
            type: 'mr',
            projectRef: { host: 'gitlab.example', path: 'acme/orca' }
          },
          body: '',
          comments: []
        }
      }
    }
    if (method === 'github.listAssignableUsers') {
      return { ok: true, result: options.assignable ?? [] }
    }
    return { ok: true, result: { ok: true } }
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function githubDetails() {
  return {
    item: {
      id: 'PR_17',
      number: 17,
      type: 'pr',
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    },
    body: '',
    comments: [
      {
        id: 11,
        author: 'ada',
        body: 'Root comment',
        createdAt: '2026-07-27T00:00:00Z'
      }
    ]
  }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
