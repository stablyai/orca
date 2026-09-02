import type { Store } from '../persistence'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { registerLocalLogTailHandlers } from './local-log-tail'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import {
  createFilesystemHandlerContext,
  type FilesystemHandlerContext
} from './filesystem/filesystem-handler-context'
import { registerFilesystemReadHandlers } from './filesystem/filesystem-read-handlers'
import { registerFilesystemDownloadHandlers } from './filesystem/filesystem-download-handlers'
import { registerFilesystemWriteHandlers } from './filesystem/filesystem-write-handlers'
import { registerFilesystemSearchHandlers } from './filesystem/filesystem-search-handlers'
import { registerFilesystemGitStatusHandlers } from './filesystem/filesystem-git-status-handlers'
import { registerFilesystemGitCommitHandlers } from './filesystem/filesystem-git-commit-handlers'
import { registerFilesystemGitCommitGenerationHandlers } from './filesystem/filesystem-git-commit-generation-handlers'
import { registerFilesystemGitModelDiscoveryHandlers } from './filesystem/filesystem-git-model-discovery-handlers'
import { registerFilesystemGitPullRequestGenerationHandlers } from './filesystem/filesystem-git-pull-request-generation-handlers'
import { registerFilesystemGitRemoteHandlers } from './filesystem/filesystem-git-remote-handlers'
import { registerFilesystemGitDiffHandlers } from './filesystem/filesystem-git-diff-handlers'
import { registerFilesystemGitIndexHandlers } from './filesystem/filesystem-git-index-handlers'
import { registerFilesystemGitUrlHandlers } from './filesystem/filesystem-git-url-handlers'

export function registerFilesystemHandlers(
  store: Store,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  const context: FilesystemHandlerContext = createFilesystemHandlerContext(
    store,
    commitMessageAgentEnv,
    createSenderScopedRequestCancellations(),
    createSenderScopedRequestCancellations()
  )

  registerFilesystemReadHandlers(context)
  registerFilesystemDownloadHandlers(context)
  registerFilesystemWriteHandlers(context)
  registerFilesystemSearchHandlers(context)
  registerFilesystemGitStatusHandlers(context)
  registerFilesystemGitCommitHandlers(context)
  registerFilesystemGitCommitGenerationHandlers(context)
  registerFilesystemGitModelDiscoveryHandlers(context)
  registerFilesystemGitPullRequestGenerationHandlers(context)
  registerFilesystemGitRemoteHandlers(context)
  registerFilesystemGitDiffHandlers(context)
  registerFilesystemGitIndexHandlers(context)
  registerFilesystemGitUrlHandlers(context)
  registerLocalLogTailHandlers(store)
}
