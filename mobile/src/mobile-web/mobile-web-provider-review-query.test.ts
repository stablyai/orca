import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const HOST_WORKSPACE_ID = 'repo-1::/private/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, HOST_WORKSPACE_ID)

describe('mobile web provider review queries', () => {
  it('returns bounded assignable-user identity without provider URLs', async () => {
    const client = rpcClient()
    const result = await executeMobileWebProviderOperation({
      operation: 'reviewQuery',
      payload: { ...identity(), query: 'assignableUsers' },
      client,
      workspaceAuthority
    })

    expect(result).toMatchObject({
      query: 'assignableUsers',
      users: [{ login: 'ada', name: 'Ada' }]
    })
    expect(JSON.stringify(result)).not.toContain('avatar')
  })

  it('revalidates an exact retained check before loading bounded details', async () => {
    const client = rpcClient()
    const result = await executeMobileWebProviderOperation({
      operation: 'reviewQuery',
      payload: {
        ...identity(),
        query: 'checkDetails',
        checkName: 'build',
        checkRunId: 9
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('github.prCheckDetails', {
      repo: 'id:repo-1',
      checkName: 'build',
      checkRunId: 9,
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
    expect(result).toMatchObject({
      query: 'checkDetails',
      details: {
        name: 'build',
        annotations: [{ path: 'src/app.ts', startLine: 4 }],
        jobs: [{ name: 'build', steps: [{ name: 'compile' }] }]
      }
    })

    const stale = rpcClient()
    await expect(
      executeMobileWebProviderOperation({
        operation: 'reviewQuery',
        payload: {
          ...identity(),
          query: 'checkDetails',
          checkName: 'other',
          checkRunId: 9
        },
        client: stale,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(stale, 'github.prCheckDetails')).toHaveLength(0)
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

function rpcClient(): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'git.status') {
      return {
        ok: true,
        result: { head: HEAD, branch: 'feature/review', conflictOperation: 'unknown' }
      }
    }
    if (method === 'hostedReview.forBranch') {
      return {
        ok: true,
        result: {
          provider: 'github',
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
      return {
        ok: true,
        result: {
          item: {
            id: 'PR_17',
            number: 17,
            type: 'pr',
            prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
          },
          body: '',
          comments: [],
          checks: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              checkRunId: 9
            }
          ]
        }
      }
    }
    if (method === 'github.listAssignableUsers') {
      return {
        ok: true,
        result: [
          {
            login: 'ada',
            name: 'Ada',
            avatarUrl: 'https://avatars.example/private',
            secret: 'drop'
          }
        ]
      }
    }
    if (method === 'github.prCheckDetails') {
      return {
        ok: true,
        result: {
          name: 'build',
          status: 'completed',
          conclusion: 'failure',
          annotations: [{ path: 'src/app.ts', startLine: 4, message: 'Fix this' }],
          jobs: [
            {
              name: 'build',
              conclusion: 'failure',
              logTail: 'failed',
              steps: [{ name: 'compile', conclusion: 'failure' }]
            }
          ]
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
