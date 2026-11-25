import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { registerGitRemoteBranchMutationHandlers } from './branch-mutation-handlers'
import { registerGitRemoteCompareHandlers } from './compare-handlers'
import { registerGitRemoteSyncHandlers } from './sync-handlers'

export function registerFilesystemGitRemoteHandlers(context: FilesystemHandlerContext): void {
  registerGitRemoteCompareHandlers(context)
  registerGitRemoteSyncHandlers(context)
  registerGitRemoteBranchMutationHandlers(context)
}
