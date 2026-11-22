import { type BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { FolderWorkspacePathStatusRequest } from '../../../shared/folder-workspaces/folder-workspace-path-status'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from '../../project-groups/folder-workspace-path-status'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { notifyReposChanged } from './repos-changed-notification'
import {
  FolderWorkspaceCreateArgs,
  FolderWorkspacePathStatusArgs,
  FolderWorkspaceDeleteArgs,
  FolderWorkspaceUpdateArgs,
  parseProjectGroupIpcArgs
} from './repo-ipc-arg-schemas'
import { visibleFolderWorkspaces } from '../../persistence/migrating-orcad-catalog/source/catalog/orcad-source-visibility'
import {
  isLocalWslMoveRow,
  shouldDropWslMoveProjectUpdate
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'

export function registerFolderWorkspaceHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: Pick<OrcaRuntimeService, 'deleteFolderWorkspace' | 'createFolderWorkspace'>
): void {
  ipcMain.handle('folderWorkspaces:list', (): FolderWorkspace[] => visibleFolderWorkspaces(store))

  ipcMain.handle('folderWorkspaces:getPathStatus', async (_event, rawArgs: unknown) => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspacePathStatusArgs,
      rawArgs,
      'invalid_folder_workspace_path_status_args'
    ) as FolderWorkspacePathStatusRequest
    return getFolderWorkspacePathStatus(store, args)
  })

  ipcMain.handle('folderWorkspaces:create', async (_event, rawArgs: unknown) => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspaceCreateArgs,
      rawArgs,
      'invalid_folder_workspace_create_args'
    )
    return runtime.createFolderWorkspace({
      ...args,
      rendererOwnsSetup: true,
      creatorProvenance: { kind: 'host' }
    })
  })

  ipcMain.handle(
    'folderWorkspaces:update',
    async (_event, rawArgs: unknown): Promise<FolderWorkspace | null> => {
      const args = parseProjectGroupIpcArgs(
        FolderWorkspaceUpdateArgs,
        rawArgs,
        'invalid_folder_workspace_update_args'
      )
      const existing = store.getFolderWorkspace(args.folderWorkspaceId)
      const ref = { folderWorkspaceId: args.folderWorkspaceId }
      if (
        existing &&
        isLocalWslMoveRow(existing) &&
        shouldDropWslMoveProjectUpdate(store, ref, args.updates)
      ) {
        return existing
      }
      if (
        typeof args.updates.folderPath === 'string' &&
        args.updates.folderPath.trim().length > 0
      ) {
        const workspace = store.getFolderWorkspace(args.folderWorkspaceId)
        if (!workspace) {
          return null
        }
        const projectGroups = store.getProjectGroups()
        const status = await getFolderWorkspacePathStatusForPath({
          folderPath: args.updates.folderPath,
          projectGroupId: workspace.projectGroupId,
          connectionId:
            workspace.connectionId ??
            projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
            null,
          projectGroups,
          repos: store.getRepos()
        })
        assertFolderWorkspacePathUsable(status)
      }
      const updated = store.updateFolderWorkspace(args.folderWorkspaceId, args.updates)
      if (updated) {
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  ipcMain.handle('folderWorkspaces:delete', async (_event, rawArgs: unknown): Promise<boolean> => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspaceDeleteArgs,
      rawArgs,
      'invalid_folder_workspace_delete_args'
    )
    // Runtime owns teardown of PTYs, browsers and sessions, plus success notifications.
    return (await runtime.deleteFolderWorkspace(args.folderWorkspaceId, args)).deleted
  })
}
