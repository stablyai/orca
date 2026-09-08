import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY } from '../tasks/worktree-create-capability'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebWorkspaceCreationCreateOperation } from './mobile-web-workspace-creation-create-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const REPO_ID = 'repo-1'

function hostClient(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (method: string) => {
    if (method === 'status.get') {
      return {
        ok: true,
        result: { capabilities: [MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY] }
      }
    }
    if (method === 'settings.get') {
      return { ok: true, result: { settings: {} } }
    }
    if (method === 'worktree.create') {
      return { ok: true, result: { worktree: { id: '/host/worktree-secret' } } }
    }
    if (method in overrides) {
      return overrides[method]
    }
    throw new Error(`Unexpected method ${method}`)
  })
}

describe('mobile web workspace creation writes', () => {
  it.each(['status.get', 'worktree.create'])(
    'does not continue a cancelled creation after %s returns',
    async (pendingMethod) => {
      let active = true
      const authority = workspaceAuthority()
      const register = vi.spyOn(authority, 'registerWorkspace')
      const host = hostClient()
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, _params, options) => {
        options?.beforeSend?.()
        const result = await host(method)
        if (method === pendingMethod) {
          active = false
        }
        return result as Awaited<ReturnType<RpcClient['sendRequest']>>
      })

      await expect(
        executeMobileWebWorkspaceCreationCreateOperation({
          operation: 'creationCreateBlank',
          payload: blankPayload(),
          client: { sendRequest } as unknown as RpcClient,
          authority,
          isRequestActive: () => active
        })
      ).rejects.toMatchObject({ code: 'cancelled' })

      expect(register).not.toHaveBeenCalled()
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'worktree.create')
      ).toHaveLength(pendingMethod === 'worktree.create' ? 1 : 0)
    }
  )

  it('rechecks cancellation at the transport write after a reconnect wait', async () => {
    let active = true
    const host = hostClient()
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, _params, options) => {
      if (method === 'worktree.create') {
        active = false
      }
      options?.beforeSend?.()
      return (await host(method)) as Awaited<ReturnType<RpcClient['sendRequest']>>
    })

    await expect(
      executeMobileWebWorkspaceCreationCreateOperation({
        operation: 'creationCreateBlank',
        payload: blankPayload(),
        client: { sendRequest } as unknown as RpcClient,
        authority: workspaceAuthority(),
        isRequestActive: () => active
      })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(host.mock.calls.map(([method]) => method)).not.toContain('worktree.create')
  })

  it('sends the page selection unchanged and answers with a fresh page handle', async () => {
    const authority = workspaceAuthority()
    const sendRequest = hostClient()

    const result = await executeMobileWebWorkspaceCreationCreateOperation({
      operation: 'creationCreateFromSource',
      payload: {
        selection: {
          kind: 'work-item',
          item: {
            provider: 'github',
            type: 'pr',
            number: 7,
            title: 'Bridge title',
            url: 'https://github.example.com/acme/orca/pull/7',
            repoId: REPO_ID
          },
          baseBranch: 'refs/pull/7/head',
          compareBaseRef: 'origin/main',
          pushTarget: { remoteName: 'contributor', branchName: 'head' }
        },
        targetRepoId: REPO_ID,
        setupDecision: 'skip',
        agentChoice: 'codex',
        sparseCheckout: { directories: ['src/renderer'], presetId: 'renderer' }
      },
      client: { sendRequest } as unknown as RpcClient,
      authority,
      isRequestActive: () => true
    })

    // The page resolved the base through the same shared operations, so nothing is looked up twice.
    expect(sendRequest.mock.calls.map(([method]) => method)).not.toContain('github.workItem')
    expect(sendRequest.mock.calls.map(([method]) => method)).not.toContain('worktree.resolvePrBase')
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        repo: `id:${REPO_ID}`,
        baseBranch: 'refs/pull/7/head',
        compareBaseRef: 'origin/main',
        createdWithAgent: 'codex',
        sparseCheckout: { directories: ['src/renderer'], presetId: 'renderer' }
      }),
      expect.anything()
    )
    expect(result).toEqual({
      workspaceId: expect.stringMatching(/^workspace_/),
      name: 'pr-7'
    })
    expect(JSON.stringify(result)).not.toContain('/host/worktree-secret')
    expect(authority.hostWorkspaceId((result as { workspaceId: string }).workspaceId)).toBe(
      '/host/worktree-secret'
    )
  })

  it('rebuilds a Linear source from its identifier because the wire carries only that', async () => {
    const authority = workspaceAuthority()
    const sendRequest = hostClient({
      'linear.searchIssues': {
        ok: true,
        result: {
          items: [
            {
              id: 'linear-1',
              identifier: 'STA-42',
              title: 'Authoritative title',
              url: 'https://linear.app/orca/issue/STA-42',
              branchName: 'sta-42-authoritative',
              updatedAt: '2026-07-23T00:00:00Z'
            }
          ]
        }
      }
    })

    await executeMobileWebWorkspaceCreationCreateOperation({
      operation: 'creationCreateFromSource',
      payload: {
        selection: {
          kind: 'work-item',
          item: {
            provider: 'linear',
            type: 'issue',
            number: 0,
            title: 'Tampered page title',
            url: 'https://linear.app/attacker/issue/STA-42',
            linearIdentifier: 'STA-42'
          },
          baseBranch: 'origin/release'
        },
        targetRepoId: REPO_ID,
        setupDecision: 'skip',
        agentChoice: 'blank'
      },
      client: { sendRequest } as unknown as RpcClient,
      authority,
      isRequestActive: () => true
    })

    expect(sendRequest.mock.calls.map(([method]) => method)).toContain('linear.searchIssues')
    const create = sendRequest.mock.calls.find(([method]) => method === 'worktree.create')!
    expect(create[1]).toMatchObject({ baseBranch: 'origin/release' })
    expect(JSON.stringify(create[1])).not.toContain('Tampered')
  })

  it('refuses an agent choice the host does not define', async () => {
    await expect(
      executeMobileWebWorkspaceCreationCreateOperation({
        operation: 'creationCreateBlank',
        payload: { ...blankPayload(), agentChoice: 'not-an-agent' },
        client: { sendRequest: hostClient() } as unknown as RpcClient,
        authority: workspaceAuthority(),
        isRequestActive: () => true
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

function blankPayload() {
  return {
    repoId: REPO_ID,
    baseName: 'secure-workspace',
    nameWasGenerated: false,
    agentChoice: 'blank',
    setupDecision: 'skip'
  }
}

function workspaceAuthority(): MobileWebWorkspaceAuthority {
  return new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(4))
}
