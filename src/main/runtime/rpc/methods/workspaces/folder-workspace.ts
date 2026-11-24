import { defineMethod } from '../../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../../callers/workspace-creator-context'
import { terminalImageViewerSupported } from '../../../terminal/launch/terminal-image-viewer-env'
import {
  FolderWorkspaceCreate,
  FolderWorkspaceDelete,
  FolderWorkspacePathStatus,
  FolderWorkspaceUpdate
} from '../../../../../shared/rpc-contract/workspaces/folder-workspace-params'
import { FolderDiffCommentMergeRequestSchema } from '../../../../../shared/file-review/folder-diff-comment-merge'

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
    params: FolderWorkspaceUpdate,
    handler: async (params, { runtime }) => ({
      folderWorkspace: await runtime.updateFolderWorkspace(
        params.folderWorkspaceId,
        params.updates,
        { requireUniqueId: params.requireUniqueId }
      )
    })
  }),
  // Why a separate method: an older host answers method_not_found instead of replacing the notes.
  defineMethod({
    name: 'folderWorkspace.mergeDiffComments',
    permission: 'workspace',
    params: FolderDiffCommentMergeRequestSchema,
    handler: (params, { runtime }) => runtime.mergeFolderDiffComments(params)
  }),
  defineMethod({
    name: 'folderWorkspace.delete',
    permission: 'workspace',
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
    params: FolderWorkspacePathStatus,
    handler: async (params, { runtime }) => ({
      status: await runtime.getFolderWorkspacePathStatus(params)
    })
  })
]
