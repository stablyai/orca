import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { FolderWorkspacePathStatusRequest } from '../../../shared/folder-workspace-path-status'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from '../../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { notifyReposChanged } from './repos-changed-notification'
import {
  FolderWorkspaceCreateArgs,
  FolderWorkspacePathStatusArgs,
  FolderWorkspaceSelectorArgs,
  FolderWorkspaceUpdateArgs,
  parseProjectGroupIpcArgs
} from './repo-ipc-arg-schemas'

export function registerFolderWorkspaceHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle('folderWorkspaces:list', (): FolderWorkspace[] => store.getFolderWorkspaces())

  ipcMain.handle('folderWorkspaces:getPathStatus', async (_event, rawArgs: unknown) => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspacePathStatusArgs,
      rawArgs,
      'invalid_folder_workspace_path_status_args'
    ) as FolderWorkspacePathStatusRequest
    return getFolderWorkspacePathStatus(store, args, { getSshFilesystemProvider })
  })

  ipcMain.handle(
    'folderWorkspaces:create',
    async (_event, rawArgs: unknown): Promise<FolderWorkspace> => {
      const args = parseProjectGroupIpcArgs(
        FolderWorkspaceCreateArgs,
        rawArgs,
        'invalid_folder_workspace_create_args'
      )
      const projectGroups = store.getProjectGroups()
      const group = projectGroups.find((entry) => entry.id === args.projectGroupId)
      const folderPath =
        typeof args.folderPath === 'string' && args.folderPath.trim().length > 0
          ? args.folderPath
          : group?.parentPath
      if (!group || !folderPath) {
        throw new Error('folder_workspace_project_group_not_found')
      }
      const status = await getFolderWorkspacePathStatusForPath(
        {
          folderPath,
          projectGroupId: group.id,
          connectionId: args.connectionId ?? group.connectionId ?? null,
          projectGroups,
          repos: store.getRepos()
        },
        { getSshFilesystemProvider }
      )
      assertFolderWorkspacePathUsable(status)
      const workspace = store.createFolderWorkspace({
        ...args,
        creatorProvenance: { kind: 'host' }
      })
      notifyReposChanged(mainWindow)
      return workspace
    }
  )

  ipcMain.handle(
    'folderWorkspaces:update',
    async (_event, rawArgs: unknown): Promise<FolderWorkspace | null> => {
      const args = parseProjectGroupIpcArgs(
        FolderWorkspaceUpdateArgs,
        rawArgs,
        'invalid_folder_workspace_update_args'
      )
      if (
        typeof args.updates.folderPath === 'string' &&
        args.updates.folderPath.trim().length > 0
      ) {
        const workspace = store.getFolderWorkspace(args.folderWorkspaceId)
        if (!workspace) {
          return null
        }
        const projectGroups = store.getProjectGroups()
        const status = await getFolderWorkspacePathStatusForPath(
          {
            folderPath: args.updates.folderPath,
            projectGroupId: workspace.projectGroupId,
            connectionId:
              workspace.connectionId ??
              projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
              null,
            projectGroups,
            repos: store.getRepos()
          },
          { getSshFilesystemProvider }
        )
        assertFolderWorkspacePathUsable(status)
      }
      const updated = store.updateFolderWorkspace(args.folderWorkspaceId, args.updates)
      if (updated) {
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  ipcMain.handle('folderWorkspaces:delete', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspaceSelectorArgs,
      rawArgs,
      'invalid_folder_workspace_delete_args'
    )
    const deleted = store.removeFolderWorkspace(args.folderWorkspaceId)
    if (deleted) {
      notifyReposChanged(mainWindow)
    }
    return deleted
  })
}
