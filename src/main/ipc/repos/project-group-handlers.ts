import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import type { NestedRepoScanResult, ProjectGroup } from '../../../shared/project-group-types'
import { notifyReposChanged } from './repos-changed-notification'
import {
  ProjectGroupCancelNestedScanArgs,
  ProjectGroupCreateArgs,
  ProjectGroupMoveProjectArgs,
  ProjectGroupScanNestedArgs,
  ProjectGroupSelectorArgs,
  ProjectGroupUpdateArgs,
  parseProjectGroupIpcArgs
} from './repo-ipc-arg-schemas'
import { activeNestedRepoScans, runNestedRepoScanForIpc } from './nested-repo-scan-ipc'

export function registerProjectGroupHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle('projectGroups:list', () => store.getProjectGroups())

  ipcMain.handle('projectGroups:create', (_event, rawArgs: unknown): ProjectGroup => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupCreateArgs,
      rawArgs,
      'invalid_project_group_create_args'
    )
    const group = store.createProjectGroup({
      name: args.name,
      parentPath: args.parentPath ?? null,
      connectionId: args.connectionId ?? null,
      parentGroupId: args.parentGroupId ?? null,
      createdFrom: args.createdFrom ?? 'manual'
    })
    notifyReposChanged(mainWindow)
    return group
  })

  ipcMain.handle('projectGroups:update', (_event, rawArgs: unknown): ProjectGroup | null => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupUpdateArgs,
      rawArgs,
      'invalid_project_group_update_args'
    )
    const updated = store.updateProjectGroup(args.groupId, args.updates)
    if (updated) {
      notifyReposChanged(mainWindow)
    }
    return updated
  })

  ipcMain.handle('projectGroups:delete', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupSelectorArgs,
      rawArgs,
      'invalid_project_group_delete_args'
    )
    const deleted = store.deleteProjectGroup(args.groupId)
    if (deleted) {
      notifyReposChanged(mainWindow)
    }
    return deleted
  })

  ipcMain.handle('projectGroups:moveProject', (_event, rawArgs: unknown): Repo | null => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupMoveProjectArgs,
      rawArgs,
      'invalid_project_group_move_repo_args'
    )
    const moved = store.moveProjectToGroup(args.projectId, args.groupId, args.order)
    if (moved) {
      notifyReposChanged(mainWindow)
    }
    return moved
  })

  ipcMain.handle(
    'projectGroups:scanNested',
    async (event, rawArgs: unknown): Promise<NestedRepoScanResult> => {
      const args = parseProjectGroupIpcArgs(
        ProjectGroupScanNestedArgs,
        rawArgs,
        'invalid_project_group_scan_nested_args'
      )
      return runNestedRepoScanForIpc(event, args)
    }
  )

  ipcMain.handle('projectGroups:cancelNestedScan', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupCancelNestedScanArgs,
      rawArgs,
      'invalid_project_group_cancel_nested_scan_args'
    )
    const controller = activeNestedRepoScans.get(args.scanId)
    if (!controller) {
      return false
    }
    controller.abort()
    return true
  })
}
