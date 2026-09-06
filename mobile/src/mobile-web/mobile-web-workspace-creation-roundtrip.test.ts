import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY } from '../tasks/worktree-create-capability'
import { webHostWorkspaceCreationOperations } from '../worktree/web-host-workspace-creation-operations'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS } from './mobile-web-production-workspace-creation-grants'

describe('mobile web workspace creation round trip', () => {
  it('carries page requests through schemas and resolves host authority only in native', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [
              {
                id: '/host/repo-secret',
                displayName: 'Orca',
                path: '/Users/private/orca',
                connectionId: 'ssh-private-id'
              }
            ]
          }
        }
      }
      if (method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY] }
        }
      }
      if (method === 'worktree.create') {
        return { ok: true, result: { worktree: { id: '/host/worktree-secret' } } }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const hostClient = { sendRequest } as unknown as RpcClient
    let requestIndex = 0
    const { client: pageClient, shellMessages } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS],
      rpcClient: hostClient,
      createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22),
      randomBytes: (length) => new Uint8Array(length).fill(5),
      navigationAuthority: {
        route: vi.fn(),
        reconnect: vi.fn(),
        removeHost: vi.fn()
      }
    })

    const repositories = await pageClient.workspaceCreation.repositories()
    const result = await pageClient.workspaceCreationCreate.createBlank({
      repoId: repositories.repositories[0]!.id,
      baseName: 'mobile-workspace',
      nameWasGenerated: false,
      agentChoice: 'codex',
      setupDecision: 'skip'
    })

    expect(repositories.repositories).toEqual([
      {
        id: expect.stringMatching(/^repo_/),
        displayName: 'Orca',
        path: '/Users/private/orca',
        connectionId: expect.stringMatching(/^repo_/),
        executionHostId: expect.stringMatching(/^ssh:executionHost_/),
        executionHostLabel: 'Host',
        projectId: expect.stringMatching(/^project_/)
      }
    ])
    expect(result).toEqual({
      workspaceId: expect.stringMatching(/^workspace_/),
      name: 'mobile-workspace'
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        repo: 'id:/host/repo-secret',
        createdWithAgent: 'codex',
        startupAgent: 'codex'
      }),
      { timeoutMs: 600_000 }
    )
    const createParams = sendRequest.mock.calls.find(
      ([method]) => method === 'worktree.create'
    )?.[1]
    expect(createParams).not.toHaveProperty('startupCommand')
    expect(sendRequest).not.toHaveBeenCalledWith('settings.get')
    expect(JSON.stringify(shellMessages)).not.toMatch(/repo-secret|worktree-secret|ssh-private-id/)
  })

  it('reaches the retired-name adapter through the hosted creation operations', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [{ id: '/host/repo-secret', displayName: 'Orca', path: '/Users/private/orca' }]
          }
        }
      }
      if (method === 'worktree.listRetiredNames') {
        return {
          ok: true,
          result: {
            retiredNamesByRepo: { '/host/repo-secret': ['nautilus'] },
            retiredNameTiersByRepo: { '/host/repo-secret': 2 }
          }
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    let requestIndex = 0
    const { client: pageClient, shellMessages } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS],
      rpcClient: { sendRequest } as unknown as RpcClient,
      createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22)
    })
    const operations = webHostWorkspaceCreationOperations(pageClient)

    const [repository] = await operations.listRepositories()

    await expect(operations.readRetiredWorktreeNames(repository!.id)).resolves.toEqual({
      exhaustedTiers: 2,
      names: ['nautilus']
    })
    expect(sendRequest).toHaveBeenLastCalledWith('worktree.listRetiredNames', {
      repo: 'id:/host/repo-secret'
    })
    expect(JSON.stringify(shellMessages)).not.toContain('repo-secret')
  })
})
