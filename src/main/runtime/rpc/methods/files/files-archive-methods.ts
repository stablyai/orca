import { defineMethod, type RpcContext } from '../../core'
import {
  FileArchiveCancel,
  FileArchiveRead,
  FileArchiveStart
} from '../../../../../shared/rpc-contract/files-archive-params'
import { getFolderArchiveSessions } from '../../../files/archive/folder-archive-sessions'

// Why device identity: one-shot calls from the same desktop may arrive on different sockets.
function archiveOwnerKey(
  context: Pick<RpcContext, 'pairedDeviceId' | 'clientId' | 'connectionId'>
) {
  return context.pairedDeviceId ?? context.clientId ?? context.connectionId ?? 'in-process'
}

/** Folder downloads: the host zips a workspace folder and the client pages the bytes. */
export const FILE_ARCHIVE_METHODS = [
  defineMethod({
    name: 'files.archiveStart',
    permission: 'workspace',
    params: FileArchiveStart,
    handler: async (params, context) => {
      // Same containment as every files.* read: workspace-relative, then authorized-root checked.
      const folderPath = await context.runtime.resolveFileExplorerArchivePath(
        params.worktree,
        params.relativePath
      )
      return getFolderArchiveSessions(context.runtime).start({
        folderPath,
        ownerKey: archiveOwnerKey(context),
        excludeDefaultDirs: params.excludeDefaultDirs !== false,
        ...(context.signal ? { signal: context.signal } : {})
      })
    }
  }),
  defineMethod({
    name: 'files.archiveRead',
    permission: 'workspace',
    params: FileArchiveRead,
    handler: async (params, context) =>
      getFolderArchiveSessions(context.runtime).read({
        archiveId: params.archiveId,
        ownerKey: archiveOwnerKey(context),
        maxBytes: params.maxBytes
      })
  }),
  defineMethod({
    name: 'files.archiveCancel',
    permission: 'workspace',
    params: FileArchiveCancel,
    handler: async (params, context) => ({
      released: getFolderArchiveSessions(context.runtime).cancel({
        archiveId: params.archiveId,
        ownerKey: archiveOwnerKey(context)
      })
    })
  })
]
