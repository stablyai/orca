import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { registerGitRemoteBranchMutationHandlers } from './git-remote/branch-mutation-handlers'
import { registerGitRemoteCompareHandlers } from './git-remote/compare-handlers'
import { registerGitRemoteSyncHandlers } from './git-remote/sync-handlers'

export function registerFilesystemGitRemoteHandlers(context: FilesystemHandlerContext): void {
  registerGitRemoteCompareHandlers(context)
  registerGitRemoteSyncHandlers(context)
  registerGitRemoteBranchMutationHandlers(context)
}
