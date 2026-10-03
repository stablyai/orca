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

  it('still deletes when the folder host is ambiguous, skipping only the PTY sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = createController(() => {
      throw new Error('folder_workspace_connection_ambiguous')
    })

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).not.toHaveBeenCalled()
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
    warn.mockRestore()
  })

  it('does not resolve the delete before the removed state cleanup lands', async () => {
    let releaseCleanup!: () => void
    const cleanupParked = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const deps = createController(() => 'ssh-1')
    deps.cleanupRemovedFolderWorkspaceState.mockReturnValue(cleanupParked)

    const deletion = deps.controller.deleteFolderWorkspace('ws-1')
    let settledEarly = false
    void deletion.then(
      () => {
        settledEarly = true
      },
      () => {}
    )
    // One macrotask is past the PTY teardown await: the cleanup has fired and
    // the catalog row is removed, while the cleanup itself is still parked. A
    // delete that resolves here is the bug — the ack must wait for the purge
    // (and the Codex pretrust deletion inside it).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
    expect(settledEarly).toBe(false)
    releaseCleanup()
    await expect(deletion).resolves.toEqual({ deleted: true })
  })
})
