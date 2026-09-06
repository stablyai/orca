import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostWorkspaceOperations } from './web-host-workspace-operations'

describe('webHostWorkspaceOperations', () => {
  it('adapts opaque bridge workspace and repository presentations', async () => {
    const client = createClient()
    const operations = webHostWorkspaceOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.listRepos()).resolves.toEqual([
      { id: 'repo-page-1', displayName: 'Orca', badgeColor: '#737373' }
    ])
    await expect(operations.listWorkspaces(10_000)).resolves.toEqual([
      expect.objectContaining({
        worktreeId: 'workspace-page-1',
        repoId: 'repo-page-1',
        displayName: 'Primary'
      })
    ])
    expect(client.workspaceSnapshot).toHaveBeenCalledWith({ limit: 200 })
  })

  it('declares its connection state as a relayed shell snapshot', () => {
    const operations = webHostWorkspaceOperations(
      createClient() as unknown as MobileWebBridgeClient
    )

    expect(operations.connectionStateIsRelayed).toBe(true)
  })

  it('routes mutations and settings through named bridge operations', async () => {
    const client = createClient()
    const operations = webHostWorkspaceOperations(client as unknown as MobileWebBridgeClient)

    await operations.setPinned('workspace-page-1', true)
    await operations.sleepWorkspace('workspace-page-1')
    await operations.activateWorkspace('workspace-page-1')
    await operations.setViewSettings({ sortBy: 'recent' })
    await expect(operations.removeWorkspace('workspace-page-1')).resolves.toBe(true)

    expect(client.workspaceUpdate).toHaveBeenNthCalledWith(1, {
      mutation: 'pin',
      workspaceId: 'workspace-page-1',
      pinned: true
    })
    expect(client.workspaceUpdate).toHaveBeenNthCalledWith(2, {
      mutation: 'sleep',
      workspaceId: 'workspace-page-1'
    })
    expect(client.workspaceActivate).toHaveBeenCalledWith({ workspaceId: 'workspace-page-1' })
    expect(client.workspaceSettingsUpdate).toHaveBeenCalledWith({ sortBy: 'recent' })
    expect(client.workspaceRemove).toHaveBeenCalledWith({ workspaceId: 'workspace-page-1' })
  })

  it('collects bounded continuation pages beyond the per-message limit', async () => {
    const client = createClient()
    const first = await client.workspaceSnapshot()
    client.workspaceSnapshot.mockReset()
    client.workspaceSnapshot
      .mockResolvedValueOnce({
        ...first,
        workspaces: Array.from({ length: 200 }, (_, index) => ({
          ...first.workspaces[0],
          id: `workspace-page-${index}`
        })),
        truncated: true,
        nextCursor: 'next-workspace-page'
      })
      .mockResolvedValueOnce({
        ...first,
        workspaces: [{ ...first.workspaces[0], id: 'workspace-page-200' }],
        truncated: false,
        nextCursor: null
      })
    const operations = webHostWorkspaceOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.listWorkspaces(201)).resolves.toHaveLength(201)
    expect(client.workspaceSnapshot).toHaveBeenNthCalledWith(1, { limit: 200 })
    expect(client.workspaceSnapshot).toHaveBeenNthCalledWith(2, {
      limit: 1,
      cursor: 'next-workspace-page'
    })
  })

  it('converts bridge subscription failures to the existing refresh event', async () => {
    const client = createClient()
    const listener = vi.fn()
    const operations = webHostWorkspaceOperations(client as unknown as MobileWebBridgeClient)

    operations.subscribeChanges(listener)
    client.onWorkspaceEvent?.({ type: 'worktreesChanged' })
    client.onWorkspaceError?.()

    expect(listener).toHaveBeenNthCalledWith(1, { type: 'worktreesChanged' })
    expect(listener).toHaveBeenNthCalledWith(2, { type: 'error' })
  })
})

function createClient() {
  const client = {
    onWorkspaceEvent: null as ((event: { type: 'worktreesChanged' }) => void) | null,
    onWorkspaceError: null as (() => void) | null,
    workspaceSettingsSnapshot: vi.fn().mockResolvedValue({ settings: { sortBy: 'recent' } }),
    workspaceSettingsUpdate: vi.fn().mockResolvedValue(null),
    workspaceRepositories: vi.fn().mockResolvedValue({
      repositories: [{ id: 'repo-page-1', displayName: 'Orca', badgeColor: '#737373' }],
      truncated: false
    }),
    workspaceSnapshot: vi.fn().mockResolvedValue({
      workspaces: [
        {
          id: 'workspace-page-1',
          repoId: 'repo-page-1',
          workspaceKind: 'git',
          name: 'Primary',
          repo: 'Orca',
          branch: 'main',
          folderName: '',
          workspaceStatus: '',
          sortOrder: 0,
          manualOrder: null,
          lastActivityAt: null,
          createdAt: null,
          isArchived: false,
          isMainWorktree: true,
          hasHostSidebarActivity: false,
          parentWorkspaceId: null,
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          lastOutputAt: null,
          isPinned: false,
          isActive: true,
          linkedPR: null,
          linkedIssue: null,
          linkedLinearIssue: null,
          linkedGitLabMR: null,
          linkedGitLabIssue: null,
          comment: '',
          status: 'inactive',
          agents: []
        }
      ],
      truncated: false
    }),
    workspaceUpdate: vi.fn().mockResolvedValue({ workspaceId: 'workspace-page-1', updated: true }),
    workspaceActivate: vi
      .fn()
      .mockResolvedValue({ workspaceId: 'workspace-page-1', activated: true }),
    workspaceRemove: vi.fn().mockResolvedValue({ workspaceId: 'workspace-page-1', removed: true }),
    workspaceSubscribe: vi.fn(
      (onEvent: (event: { type: 'worktreesChanged' }) => void, onError: () => void) => {
        client.onWorkspaceEvent = onEvent
        client.onWorkspaceError = onError
        return { ready: Promise.resolve(), unsubscribe: vi.fn() }
      }
    )
  }
  return client
}
