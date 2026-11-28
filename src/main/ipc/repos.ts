import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'
import { registerRepoCatalogHandlers } from './repos/repo-catalog-handlers'
import { registerProjectGroupHandlers } from './repos/project-group-handlers'
import { registerFolderWorkspaceHandlers } from './repos/folder-workspace-handlers'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const PROJECT_HOST_SETUP_CHANNELS = [
  'projectHostSetups:create',
  'projectHostSetups:update',
  'projectHostSetups:delete',
  'projectHostSetups:setupExistingFolder'
] as const
const REPO_CREATION_CHANNELS = [
  'repos:isGitAvailable',
  'repos:getDefaultCreateProjectParent',
  'repos:add',
  'repos:create'
] as const
const NESTED_REPO_IMPORT_CHANNELS = ['projectGroups:importNested'] as const
const REPO_UPDATE_CHANNELS = ['repos:update'] as const
const SPARSE_PRESET_CHANNELS = [
  'sparsePresets:list',
  'sparsePresets:save',
  'sparsePresets:remove'
] as const
const REPO_FOLDER_PICKER_CHANNELS = [
  'repos:pickFolder',
  'repos:pickFolders',
  'repos:pickDirectory'
] as const
const REPO_CLONE_CHANNELS = ['repos:cloneAbort', 'repos:checkCloneTarget', 'repos:clone'] as const
const BASE_REF_QUERY_CHANNELS = [
  'repos:getBaseRefDefault',
  'repos:searchBaseRefs',
  'repos:searchBaseRefDetails'
] as const

export function registerRepoHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  // macOS window recreation re-registers these handlers.
  ipcMain.removeHandler('repos:list')
  ipcMain.removeHandler('repos:listWslMoved')
  ipcMain.removeHandler('repos:listHostCatalogSnapshots')
  ipcMain.removeHandler('repos:add')
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
  ipcMain.removeHandler('projectGroups:checkHooks')
  ipcMain.removeHandler('projectGroups:list')
  ipcMain.removeHandler('projectGroups:create')
  ipcMain.removeHandler('projectGroups:update')
  ipcMain.removeHandler('projectGroups:updateMany')
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
  ipcMain.removeHandler('repos:checkCloneTarget')
  ipcMain.removeHandler('repos:cloneAbort')
  ipcMain.removeHandler('repos:isGitAvailable')
  ipcMain.removeHandler('repos:getDefaultCreateProjectParent')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')
  ipcMain.removeHandler('repos:searchBaseRefDetails')
  ipcMain.removeHandler('repos:create')
  ipcMain.removeHandler('sparsePresets:list')
  ipcMain.removeHandler('sparsePresets:save')
  ipcMain.removeHandler('sparsePresets:remove')

  registerRepoCatalogHandlers(mainWindow, store, runtime)
  const metadata = {
    enqueueRepositoryMetadata: (
      repos: Parameters<typeof runtime.repositoryForkBackfill.enqueue>[0]
    ) => void runtime.repositoryForkBackfill.enqueue(repos),
    resolveRepositoryMetadata: (
      repo: Parameters<typeof runtime.repositoryForkBackfill.resolve>[0]
    ) => runtime.repositoryForkBackfill.resolve(repo)
  }
  registerProjectGroupHandlers(mainWindow, store, runtime)
  registerFolderWorkspaceHandlers(mainWindow, store, runtime)
  registerLazyIpcHandleGroup(PROJECT_HOST_SETUP_CHANNELS, async (ipc) => {
    const { registerProjectHostSetupHandlers } = await import('./repos/project-host-setup-handlers')
    registerProjectHostSetupHandlers(mainWindow, store, metadata, ipc)
  })
  registerLazyIpcHandleGroup(REPO_CREATION_CHANNELS, async (ipc) => {
    const { registerRepoCreationHandlers } = await import('./repos/repo-creation-handlers')
    registerRepoCreationHandlers(mainWindow, store, metadata.enqueueRepositoryMetadata, ipc)
  })
  registerLazyIpcHandleGroup(NESTED_REPO_IMPORT_CHANNELS, async (ipc) => {
    const { registerNestedRepoImportHandler } = await import('./repos/nested-repo-import-handler')
    registerNestedRepoImportHandler(mainWindow, store, metadata.enqueueRepositoryMetadata, ipc)
  })
  registerLazyIpcHandleGroup(REPO_UPDATE_CHANNELS, async (ipc) => {
    const { registerRepoUpdateHandler } = await import('./repos/repo-update-handler')
    registerRepoUpdateHandler(mainWindow, store, ipc)
  })
  registerLazyIpcHandleGroup(SPARSE_PRESET_CHANNELS, async (ipc) => {
    const { registerSparsePresetHandlers } = await import('./repos/sparse-preset-handlers')
    registerSparsePresetHandlers(mainWindow, store, ipc)
  })
  registerLazyIpcHandleGroup(REPO_FOLDER_PICKER_CHANNELS, async (ipc) => {
    const { registerRepoFolderPickerHandlers } = await import('./repos/repo-folder-picker-handlers')
    registerRepoFolderPickerHandlers(mainWindow, store, ipc)
  })
  registerLazyIpcHandleGroup(REPO_CLONE_CHANNELS, async (ipc) => {
    const { registerRepoCloneHandlers } = await import('./repos/repo-clone-lifecycle')
    registerRepoCloneHandlers(mainWindow, store, metadata.enqueueRepositoryMetadata, ipc)
  })
  registerLazyIpcHandleGroup(BASE_REF_QUERY_CHANNELS, async (ipc) => {
    const { registerBaseRefQueryHandlers } = await import('./repos/base-ref-query-handlers')
    registerBaseRefQueryHandlers(store, ipc)
  })
}
