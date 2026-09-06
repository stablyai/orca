import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { resolveMobileWebHostNavigationRoute } from './mobile-web-host-navigation-route'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HOST_WORKSPACE_ID = 'repo::/private/worktree'

describe('mobile web host navigation route', () => {
  it('revalidates the Desktop workspace and returns only a current opaque handle', async () => {
    const client = hostClient({
      worktrees: [
        {
          worktreeId: HOST_WORKSPACE_ID,
          repoId: '/private/repository',
          displayName: 'Feature'
        }
      ],
      totalCount: 1,
      truncated: false
    })
    const authority = workspaceAuthority()

    const route = await resolveMobileWebHostNavigationRoute(HOST_WORKSPACE_ID, client, authority)

    expect(client.sendRequest).toHaveBeenCalledWith('worktree.ps', { limit: 10_001 })
    expect(route).toEqual({
      kind: 'session',
      workspaceId: `workspace_0_${'07'.repeat(16)}`,
      workspaceName: 'Feature'
    })
    expect(JSON.stringify(route)).not.toContain('/private/')
    expect(authority.hostWorkspaceId((route as { workspaceId: string }).workspaceId)).toBe(
      HOST_WORKSPACE_ID
    )
  })

  it('falls back to the hosted workspace list when the target disappeared', async () => {
    await expect(
      resolveMobileWebHostNavigationRoute(
        HOST_WORKSPACE_ID,
        hostClient({ worktrees: [], totalCount: 0, truncated: false }),
        workspaceAuthority()
      )
    ).resolves.toEqual({ kind: 'workspaceList' })
  })

  it.each([
    [
      'truncated',
      {
        worktrees: [],
        totalCount: 10_001,
        truncated: true
      },
      'too_large'
    ],
    [
      'ambiguous',
      {
        worktrees: [
          { worktreeId: HOST_WORKSPACE_ID, repoId: 'repo-one' },
          { worktreeId: HOST_WORKSPACE_ID, repoId: 'repo-two' }
        ],
        totalCount: 2,
        truncated: false
      },
      'unavailable'
    ],
    [
      'malformed target',
      {
        worktrees: [{ worktreeId: HOST_WORKSPACE_ID }],
        totalCount: 1,
        truncated: false
      },
      'unavailable'
    ]
  ])('rejects a %s Desktop snapshot', async (_label, result, code) => {
    await expect(
      resolveMobileWebHostNavigationRoute(
        HOST_WORKSPACE_ID,
        hostClient(result),
        workspaceAuthority()
      )
    ).rejects.toMatchObject({ code })
  })

  it('rejects an oversized Desktop snapshot before registering its target', async () => {
    const result = {
      worktrees: [
        {
          worktreeId: HOST_WORKSPACE_ID,
          repoId: 'repo',
          displayName: 'x'.repeat(8 * 1024 * 1024)
        }
      ],
      totalCount: 1,
      truncated: false
    }
    await expect(
      resolveMobileWebHostNavigationRoute(
        HOST_WORKSPACE_ID,
        hostClient(result),
        workspaceAuthority()
      )
    ).rejects.toMatchObject({ code: 'too_large' })
  })
})

function hostClient(result: unknown): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      id: 'response',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime' }
    })
  } as unknown as RpcClient
}

function workspaceAuthority(): MobileWebWorkspaceAuthority {
  return new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
}
