import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

describe('mobile web workspace snapshot pager', () => {
  it('serves a stable host snapshot through bounded single-use continuations', async () => {
    const client = workspaceClient(3)
    const pager = new MobileWebWorkspaceSnapshotPager((length) => new Uint8Array(length).fill(2))
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(1))

    const first = await pager.snapshot({ limit: 2 }, client, authority)
    expect(first).toMatchObject({
      workspaces: [{ name: 'Workspace 0' }, { name: 'Workspace 1' }],
      truncated: true
    })
    expect(first.nextCursor).toMatch(/^workspace_page_0_[a-f0-9]{32}$/)

    const second = await pager.snapshot({ limit: 2, cursor: first.nextCursor! }, client, authority)
    expect(second).toMatchObject({
      workspaces: [{ name: 'Workspace 2' }],
      truncated: false,
      nextCursor: null
    })
    expect(client.sendRequest).toHaveBeenCalledOnce()
    expect(JSON.stringify([first, second])).not.toContain('/private/')
    await expect(
      pager.snapshot({ limit: 2, cursor: first.nextCursor! }, client, authority)
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('retires an in-flight snapshot on cleanup without blocking the replacement client', async () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    const pager = new MobileWebWorkspaceSnapshotPager((length) => new Uint8Array(length))
    const oldResponse = Promise.withResolvers<Awaited<ReturnType<RpcClient['sendRequest']>>>()
    const oldClient = { sendRequest: vi.fn(() => oldResponse.promise) } as unknown as RpcClient
    const pending = pager.snapshot({ limit: 1 }, oldClient, authority)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' })

    pager.clear()
    authority.clear()
    const current = await pager.snapshot({ limit: 1 }, workspaceClient(2), authority)
    oldResponse.resolve({ ok: true, result: { worktrees: [{ worktreeId: 'retired-workspace' }] } })
    await rejection

    expect(() => authority.pageWorkspaceId('retired-workspace')).toThrow('not_found')
    expect(authority.hostWorkspaceId(current.workspaces[0]!.id)).toBe('host-workspace-0')
    await expect(
      pager.snapshot({ limit: 1, cursor: current.nextCursor! }, workspaceClient(0), authority)
    ).resolves.toMatchObject({ workspaces: [{ name: 'Workspace 1' }], nextCursor: null })
  })

  it('revokes continuations on lifecycle cleanup and rejects oversized host lists', async () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    const pager = new MobileWebWorkspaceSnapshotPager((length) => new Uint8Array(length))
    const client = workspaceClient(2)
    const first = await pager.snapshot({ limit: 1 }, client, authority)

    pager.clear()
    await expect(
      pager.snapshot({ limit: 1, cursor: first.nextCursor! }, client, authority)
    ).rejects.toMatchObject({ code: 'invalid_request' })

    const oversized = {
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: { worktrees: [], totalCount: 10_001, truncated: true }
      })
    } as unknown as RpcClient
    await expect(pager.snapshot({ limit: 1 }, oversized, authority)).rejects.toMatchObject({
      code: 'too_large'
    })
  })
})

function workspaceClient(count: number): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        worktrees: Array.from({ length: count }, (_, index) => ({
          worktreeId: `host-workspace-${index}`,
          repoId: 'host-repo',
          displayName: `Workspace ${index}`,
          repo: '/private/repository',
          path: `/private/worktree-${index}`,
          branch: 'main'
        })),
        totalCount: count,
        truncated: false
      }
    })
  } as unknown as RpcClient
}
