import { removeAppHandler } from './app-registry/app-handler-registry'
import type { BrowserWindow } from 'electron'

import type { Store } from '../persistence/loading-store/store'
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
import { registerBaseRefQueryHandlers } from './repos/base-ref-query-handlers'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export function registerRepoHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  // macOS window recreation re-registers these handlers.
  removeAppHandler('repos:list')
  removeAppHandler('repos:listWslMoved')
  removeAppHandler('repos:listHostCatalogSnapshots')
  removeAppHandler('repos:add')
  removeAppHandler('repos:removeForHost')
  removeAppHandler('repos:reorder')
  removeAppHandler('repos:reorderForHost')
  removeAppHandler('repos:update')
  removeAppHandler('projects:list')
  removeAppHandler('projects:update')
  removeAppHandler('projectHostSetups:list')
  removeAppHandler('projectHostSetups:create')
  removeAppHandler('projectHostSetups:setupExistingFolder')
  removeAppHandler('projectHostSetups:update')
  removeAppHandler('projectHostSetups:delete')
  removeAppHandler('projectGroups:checkHooks')
  removeAppHandler('projectGroups:list')
  removeAppHandler('projectGroups:create')
  removeAppHandler('projectGroups:update')
  removeAppHandler('projectGroups:updateMany')
  removeAppHandler('projectGroups:delete')
  removeAppHandler('projectGroups:moveProject')
  removeAppHandler('projectGroups:scanNested')
  removeAppHandler('projectGroups:cancelNestedScan')
  removeAppHandler('projectGroups:importNested')
  removeAppHandler('folderWorkspaces:list')
  removeAppHandler('folderWorkspaces:create')
  removeAppHandler('folderWorkspaces:update')
  removeAppHandler('folderWorkspaces:delete')
  removeAppHandler('folderWorkspaces:getPathStatus')
  removeAppHandler('repos:pickFolder')
  removeAppHandler('repos:pickFolders')
  removeAppHandler('repos:pickDirectory')
  removeAppHandler('repos:clone')
  removeAppHandler('repos:checkCloneTarget')
  removeAppHandler('repos:cloneAbort')
  removeAppHandler('repos:isGitAvailable')
  removeAppHandler('repos:getDefaultCreateProjectParent')
  removeAppHandler('repos:getBaseRefDefault')
  removeAppHandler('repos:searchBaseRefs')
  removeAppHandler('repos:searchBaseRefDetails')
  removeAppHandler('repos:create')
  removeAppHandler('sparsePresets:list')
  removeAppHandler('sparsePresets:save')
  removeAppHandler('sparsePresets:remove')

  registerRepoCatalogHandlers(mainWindow, store, runtime)
  const metadata = {
    enqueueRepositoryMetadata: (
      repos: Parameters<typeof runtime.repositoryForkBackfill.enqueue>[0]
    ) => void runtime.repositoryForkBackfill.enqueue(repos),
    resolveRepositoryMetadata: (
      repo: Parameters<typeof runtime.repositoryForkBackfill.resolve>[0]
    ) => runtime.repositoryForkBackfill.resolve(repo)
  }
  registerProjectHostSetupHandlers(mainWindow, store, metadata)
  registerRepoCreationHandlers(mainWindow, store, metadata.enqueueRepositoryMetadata)
  registerProjectGroupHandlers(mainWindow, store, runtime)
  registerFolderWorkspaceHandlers(mainWindow, store, runtime)
  registerNestedRepoImportHandler(mainWindow, store, metadata.enqueueRepositoryMetadata)
  registerRepoUpdateHandler(mainWindow, store)
  registerSparsePresetHandlers(mainWindow, store)
  registerRepoFolderPickerHandlers(mainWindow, store)
  registerRepoCloneHandlers(mainWindow, store, metadata.enqueueRepositoryMetadata)
  registerBaseRefQueryHandlers(store)
}
