import { defineMethod } from '../../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../../callers/workspace-creator-context'
import { terminalImageViewerSupported } from '../../../terminal/launch/terminal-image-viewer-env'
import {
  FolderWorkspaceCreate,
  FolderWorkspaceDelete,
  FolderWorkspacePathStatus,
  FolderWorkspaceUpdate
} from '../../../../../shared/rpc-contract/workspaces/folder-workspace-params'

export const FOLDER_WORKSPACE_METHODS = [
  defineMethod({
    name: 'folderWorkspace.list',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => ({
      folderWorkspaces: runtime.listVisibleFolderWorkspaces()
    })
  }),
  defineMethod({
    name: 'folderWorkspace.create',
    permission: 'workspace',
    share: 'not-shared',
    params: FolderWorkspaceCreate,
    handler: async (params, context) => {
      const viewerSupported = terminalImageViewerSupported(context)
      return context.runtime.createFolderWorkspace({
        ...params,
        signal: context.signal,
        creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context),
        ...(viewerSupported !== undefined ? { terminalImageViewerSupported: viewerSupported } : {})
      })
    }
  }),
  defineMethod({
    name: 'folderWorkspace.update',
    permission: 'workspace',
    share: 'not-shared',
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
    share: 'not-shared',
    params: FolderWorkspaceDelete,
    handler: async (params, { runtime }) =>
      runtime.deleteFolderWorkspace(params.folderWorkspaceId, {
        requireUniqueId: params.requireUniqueId,
        runHooks: params.runHooks,
        allowFailedArchiveHook: params.allowFailedArchiveHook
      })
  }),
  defineMethod({
    name: 'folderWorkspace.getPathStatus',
    permission: 'workspace',
    share: 'not-shared',
    params: FolderWorkspacePathStatus,
    handler: async (params, { runtime }) => ({
      status: await runtime.getFolderWorkspacePathStatus(params)
    })
  })
]
