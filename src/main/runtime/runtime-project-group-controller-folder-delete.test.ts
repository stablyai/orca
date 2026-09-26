import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

const workspace = {
  id: 'ws-1',
  projectGroupId: 'group-1',
  folderPath: '/tmp/ws'
} as FolderWorkspace

function createController(
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
) {
  const removeFolderWorkspace = vi.fn(() => true)
  const teardownFolderWorkspacePtys = vi.fn(async () => undefined)
  const cleanupRemovedFolderWorkspaceState = vi.fn()
  const notifyReposChanged = vi.fn()
  const controller = new RuntimeProjectGroupController({
    getStore: () => ({ getFolderWorkspaces: () => [workspace], removeFolderWorkspace }) as never,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged,
    resolveFolderConnectionId,
    teardownFolderWorkspacePtys,
    cleanupRemovedFolderWorkspaceState
  })
  return {
    controller,
    removeFolderWorkspace,
    teardownFolderWorkspacePtys,
    cleanupRemovedFolderWorkspaceState,
    notifyReposChanged
  }
}

describe('RuntimeProjectGroupController.deleteFolderWorkspace', () => {
  it('tears down PTYs and runtime state before removing the catalog row', async () => {
    const deps = createController(() => 'ssh-1')

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).toHaveBeenCalledWith('folder:ws-1', 'ssh-1')
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.teardownFolderWorkspacePtys.mock.invocationCallOrder[0]).toBeLessThan(
      deps.removeFolderWorkspace.mock.invocationCallOrder[0]!
    )
    expect(deps.notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('sweeps PTYs on the recorded host when the folder host inference is ambiguous', async () => {
    // Ambiguity now resolves to the record authority instead of throwing, so the
    // sweep targets the host the workspace was actually recorded on.
    const deps = createController(() => 'ssh-recorded')

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).toHaveBeenCalledWith('folder:ws-1', 'ssh-recorded')
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
  })

  it('sweeps local PTYs when an ambiguous workspace has no recorded connection', async () => {
    const deps = createController(() => null)

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).toHaveBeenCalledWith('folder:ws-1', null)
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
  })
})
