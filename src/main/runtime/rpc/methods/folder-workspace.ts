import { defineMethod } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import {
  FolderWorkspaceCreate,
  FolderWorkspacePathStatus,
  FolderWorkspaceSelector,
  FolderWorkspaceUpdate
} from '../../../../shared/rpc-contract/folder-workspace-params'

export const FOLDER_WORKSPACE_METHODS = [
  defineMethod({
    name: 'folderWorkspace.list',
    params: null,
    handler: (_params, { runtime }) => ({
      folderWorkspaces: runtime.listFolderWorkspaces()
    })
  }),
  defineMethod({
    name: 'folderWorkspace.create',
    params: FolderWorkspaceCreate,
    handler: async (params, context) => ({
      folderWorkspace: await context.runtime.createFolderWorkspace({
        ...params,
        creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
      })
    })
  }),
  defineMethod({
    name: 'folderWorkspace.update',
    params: FolderWorkspaceUpdate,
    handler: async (params, { runtime }) => ({
      folderWorkspace: await runtime.updateFolderWorkspace(params.folderWorkspaceId, params.updates)
    })
  }),
  defineMethod({
    name: 'folderWorkspace.delete',
    params: FolderWorkspaceSelector,
    handler: async (params, { runtime }) => runtime.deleteFolderWorkspace(params.folderWorkspaceId)
  }),
  defineMethod({
    name: 'folderWorkspace.getPathStatus',
    params: FolderWorkspacePathStatus,
    handler: async (params, { runtime }) => ({
      status: await runtime.getFolderWorkspacePathStatus(params)
    })
  })
]
