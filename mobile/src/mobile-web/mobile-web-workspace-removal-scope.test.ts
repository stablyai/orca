import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

function catalog(worktreeIds: readonly string[]) {
  return {
    ok: true as const,
    result: {
      worktrees: worktreeIds.map((worktreeId) => ({
        worktreeId,
        repoId: 'repo-1',
        displayName: worktreeId,
        repo: '/repo',
        branch: 'main'
      }))
    }
  }
}

describe('workspace removal scope', () => {
  it('never reaches worktree.rm with a handle the catalog no longer binds', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>()
    sendRequest.mockResolvedValueOnce(catalog(['host-workspace-a', 'host-workspace-b']))
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const first = await client.workspaceSnapshot({ limit: 10 })
    const removedWorkspaceId = first.workspaces[0]!.id

    sendRequest.mockResolvedValueOnce(catalog(['host-workspace-b']))
    await client.workspaceSnapshot({ limit: 10 })

    await expect(client.workspaceRemove({ workspaceId: removedWorkspaceId })).rejects.toMatchObject(
      { code: 'not_found' }
    )
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['worktree.ps', 'worktree.ps'])
  })

  it('removes the workspace the page handle still binds', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>()
    sendRequest.mockResolvedValueOnce(catalog(['host-workspace-a']))
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      rpcClient: { sendRequest } as unknown as RpcClient
    })
    const snapshot = await client.workspaceSnapshot({ limit: 10 })

    sendRequest.mockResolvedValueOnce({ ok: true, result: { removed: true } })
    await expect(
      client.workspaceRemove({ workspaceId: snapshot.workspaces[0]!.id })
    ).resolves.toEqual({ workspaceId: snapshot.workspaces[0]!.id, removed: true })
    expect(sendRequest).toHaveBeenLastCalledWith(
      'worktree.rm',
      { worktree: 'id:host-workspace-a', force: true },
      expect.anything()
    )
  })
})
