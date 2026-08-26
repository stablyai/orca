import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { registerRepoCatalogHandlers } from './repos/repo-catalog-handlers'
import { registerProjectHostSetupHandlers } from './repos/project-host-setup-handlers'
import { registerRepoCreationHandlers } from './repos/repo-creation-handlers'
import { registerProjectGroupHandlers } from './repos/project-group-handlers'
import { registerFolderWorkspaceHandlers } from './repos/folder-workspace-handlers'
import { registerNestedRepoImportHandler } from './repos/nested-repo-import-handler'
import { registerRepoUpdateHandler } from './repos/repo-update-handler'
import { registerSparsePresetHandlers } from './repos/sparse-preset-handlers'
import { registerRepoFolderPickerHandlers } from './repos/repo-folder-picker-handlers'
import { registerRepoCloneHandlers } from './repos/repo-clone-lifecycle'
import { registerRepoGitUsernameHandler } from './repos/repo-git-username-handler'
import { registerBaseRefQueryHandlers } from './repos/base-ref-query-handlers'

export function registerRepoHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove previously registered handlers so we can re-register on macOS app re-activation (new window).
  ipcMain.removeHandler('repos:list')
  ipcMain.removeHandler('repos:listForExecutionHost')
  ipcMain.removeHandler('repos:add')
  ipcMain.removeHandler('repos:remove')
  ipcMain.removeHandler('repos:removeForHost')
  ipcMain.removeHandler('repos:reorder')
  ipcMain.removeHandler('repos:reorderForHost')
  ipcMain.removeHandler('repos:update')
  ipcMain.removeHandler('projects:list')
  ipcMain.removeHandler('projects:update')
  ipcMain.removeHandler('projectHostSetups:list')
  ipcMain.removeHandler('projectHostSetups:create')
  ipcMain.removeHandler('projectHostSetups:setupExistingFolder')
  ipcMain.removeHandler('projectHostSetups:update')
  ipcMain.removeHandler('projectHostSetups:delete')
  ipcMain.removeHandler('projectGroups:list')
  ipcMain.removeHandler('projectGroups:create')
  ipcMain.removeHandler('projectGroups:update')
  ipcMain.removeHandler('projectGroups:delete')
  ipcMain.removeHandler('projectGroups:moveProject')
  ipcMain.removeHandler('projectGroups:scanNested')
  ipcMain.removeHandler('projectGroups:cancelNestedScan')
  ipcMain.removeHandler('projectGroups:importNested')
  ipcMain.removeHandler('folderWorkspaces:list')
  ipcMain.removeHandler('folderWorkspaces:create')
  ipcMain.removeHandler('folderWorkspaces:update')
  ipcMain.removeHandler('folderWorkspaces:delete')
  ipcMain.removeHandler('folderWorkspaces:getPathStatus')
  ipcMain.removeHandler('repos:pickFolder')
  ipcMain.removeHandler('repos:pickFolders')
  ipcMain.removeHandler('repos:pickDirectory')
  ipcMain.removeHandler('repos:clone')
  ipcMain.removeHandler('repos:cloneAbort')
  ipcMain.removeHandler('repos:cloneRemote')
  ipcMain.removeHandler('repos:isGitAvailable')
  ipcMain.removeHandler('repos:getDefaultCreateProjectParent')
  ipcMain.removeHandler('repos:getGitUsername')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')
  ipcMain.removeHandler('repos:searchBaseRefDetails')
  ipcMain.removeHandler('repos:addRemote')
  ipcMain.removeHandler('repos:create')
  ipcMain.removeHandler('repos:createRemote')
  ipcMain.removeHandler('sparsePresets:list')
  ipcMain.removeHandler('sparsePresets:save')
  ipcMain.removeHandler('sparsePresets:remove')

  registerRepoCatalogHandlers(mainWindow, store)
  registerProjectHostSetupHandlers(mainWindow, store)
  registerRepoCreationHandlers(mainWindow, store)
  registerProjectGroupHandlers(mainWindow, store)
  registerFolderWorkspaceHandlers(mainWindow, store)
  registerNestedRepoImportHandler(mainWindow, store)
  registerRepoUpdateHandler(mainWindow, store)
  registerSparsePresetHandlers(mainWindow, store)
  registerRepoFolderPickerHandlers(mainWindow)
  registerRepoCloneHandlers(mainWindow, store)
  registerRepoGitUsernameHandler(store)
  registerBaseRefQueryHandlers(store)
}
