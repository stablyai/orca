import { defineMethod } from '../../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../../callers/workspace-creator-context'
import {
  FolderWorkspaceCreate,
  FolderWorkspaceDelete,
  FolderWorkspacePathStatus,
  FolderWorkspaceUpdate
} from '../../../../../shared/rpc-contract/folder-workspace-params'

export const FOLDER_WORKSPACE_METHODS = [
  defineMethod({
    name: 'folderWorkspace.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({
      folderWorkspaces: runtime.listVisibleFolderWorkspaces()
    })
  }),
  defineMethod({
    name: 'folderWorkspace.create',
    permission: 'workspace',
    params: FolderWorkspaceCreate,
    handler: async (params, context) =>
      context.runtime.createFolderWorkspace({
        ...params,
        signal: context.signal,
        creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
      })
  }),
  defineMethod({
    name: 'folderWorkspace.update',
    permission: 'workspace',
    params: FolderWorkspaceUpdate,
    handler: async (params, { runtime }) => ({
      folderWorkspace: await runtime.updateFolderWorkspace(
        params.folderWorkspaceId,
        params.updates,
        { requireUniqueId: params.requireUniqueId }
      )
    })
  }),
  defineMethod({
    name: 'folderWorkspace.delete',
    permission: 'workspace',
    params: FolderWorkspaceDelete,
    handler: async (params, { runtime }) =>
      runtime.deleteFolderWorkspace(params.folderWorkspaceId, {
        ...params,
        requireUniqueId: params.requireUniqueId
      })
  }),
  defineMethod({
    name: 'folderWorkspace.getPathStatus',
    permission: 'workspace',
    params: FolderWorkspacePathStatus,
    handler: async (params, { runtime }) => ({
      status: await runtime.getFolderWorkspacePathStatus(params)
    })
  })
]
