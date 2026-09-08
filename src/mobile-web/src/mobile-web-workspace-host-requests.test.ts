import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebWorkspaceRequestClient } from './mobile-web-workspace-request-client'

const WORKSPACE_ID = 'workspace-page-1'

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  return {
    request,
    client: new MobileWebWorkspaceRequestClient({
      request
    } as unknown as MobileWebOneShotRequestClient)
  }
}

function hostCall(method: string, workspaceId: string | undefined, params: unknown) {
  return [
    'workspace',
    'hostRequest',
    { method, ...(workspaceId === undefined ? {} : { workspaceId }), params },
    expect.anything(),
    expect.anything(),
    undefined
  ]
}

describe('host-forwarded workspace requests', () => {
  it('activates through worktree.activate and echoes the page handle', async () => {
    const f = fixture({
      worktreeId: 'host-workspace-1',
      activated: true,
      sleepingAgentWake: 'requested'
    })

    await expect(f.client.activate({ workspaceId: WORKSPACE_ID })).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      activated: true,
      sleepingAgentWake: 'requested'
    })
    expect(f.request).toHaveBeenCalledWith(
      ...hostCall('worktree.activate', WORKSPACE_ID, {
        notifyClients: false,
        navigation: 'caller'
      })
    )
  })

  it('rejects an activation the host did not confirm', async () => {
    await expect(
      fixture({ activated: false, sleepingAgentWake: 'requested' }).client.activate({
        workspaceId: WORKSPACE_ID
      })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('pins through worktree.set and sleeps through worktree.sleep', async () => {
    const f = fixture({ worktree: {} })

    await expect(
      f.client.update({ mutation: 'pin', workspaceId: WORKSPACE_ID, pinned: true })
    ).resolves.toEqual({ workspaceId: WORKSPACE_ID, updated: true })
    await expect(
      f.client.update({ mutation: 'sleep', workspaceId: WORKSPACE_ID })
    ).resolves.toEqual({ workspaceId: WORKSPACE_ID, updated: true })
    expect(f.request).toHaveBeenNthCalledWith(
      1,
      ...hostCall('worktree.set', WORKSPACE_ID, { isPinned: true })
    )
    expect(f.request).toHaveBeenNthCalledWith(2, ...hostCall('worktree.sleep', WORKSPACE_ID, {}))
  })

  it('removes through worktree.rm and refuses an unremoved answer', async () => {
    const f = fixture({ removed: true })

    await expect(f.client.remove({ workspaceId: WORKSPACE_ID })).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      removed: true
    })
    expect(f.request).toHaveBeenCalledWith(
      ...hostCall('worktree.rm', WORKSPACE_ID, { force: true })
    )
    await expect(
      fixture({ removed: false }).client.remove({ workspaceId: WORKSPACE_ID })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('bounds a repo.list catalog and drops a row it cannot read', async () => {
    const f = fixture({
      repos: [
        { id: 'repo-1', displayName: 'Orca', path: '/host/repos/orca', badgeColor: '#737373' },
        { displayName: 'no id' },
        { id: 'repo-2', displayName: 'Second', repoIcon: { type: 'lucide', name: 'FolderGit2' } }
      ]
    })

    await expect(f.client.repositories()).resolves.toMatchObject({
      truncated: false,
      repositories: [{ id: 'repo-1', displayName: 'Orca' }, { id: 'repo-2' }]
    })
    expect(f.request).toHaveBeenCalledWith(...hostCall('repo.list', undefined, {}))
  })

  it('reads only the view keys out of a whole ui.get snapshot', async () => {
    const f = fixture({
      ui: {
        sortBy: 'recent',
        filterRepoIds: ['repo-1'],
        trustedOrcaHooks: { 'repo-1': 'must-not-cross' },
        sidebarWidth: 320
      }
    })

    await expect(f.client.settingsSnapshot()).resolves.toEqual({
      settings: { sortBy: 'recent', filterRepoIds: ['repo-1'] }
    })
  })

  it('writes back only the view keys so ui.set merges the rest', async () => {
    const f = fixture({ ui: {} })

    await expect(f.client.settingsUpdate({ sortBy: 'manual' })).resolves.toBeNull()
    expect(f.request).toHaveBeenCalledWith(...hostCall('ui.set', undefined, { sortBy: 'manual' }))
  })
})
