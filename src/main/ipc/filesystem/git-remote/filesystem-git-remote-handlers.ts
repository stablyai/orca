import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { registerGitRemoteBranchMutationHandlers } from './branch-mutation-handlers'
import { registerGitRemoteCompareHandlers } from './compare-handlers'
import { registerGitRemoteSyncHandlers } from './sync-handlers'

export function registerFilesystemGitRemoteHandlers(
  context: FilesystemHandlerContext,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  registerGitRemoteCompareHandlers(context, ipc)
  registerGitRemoteSyncHandlers(context, ipc)
  registerGitRemoteBranchMutationHandlers(context, ipc)
}
