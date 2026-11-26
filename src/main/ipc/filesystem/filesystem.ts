import type { Store } from '../../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import { registerLocalLogTailHandlers } from './reads/local-log-tail'
import { createSenderScopedRequestCancellations } from '../renderer-requests/sender-scoped-request-cancellation'
import {
  createFilesystemHandlerContext,
  type FilesystemHandlerContext
} from './filesystem-handler-context'
import { registerFilesystemReadHandlers } from './reads/filesystem-read-handlers'
import { registerFilesystemDownloadHandlers } from './downloads/filesystem-download-handlers'
import { registerFilesystemWriteHandlers } from './mutations/filesystem-write-handlers'
import { registerFilesystemSearchHandlers } from './search/filesystem-search-handlers'
import { registerFilesystemGitStatusHandlers } from './source-control/filesystem-git-status-handlers'
import { registerFilesystemGitCommitHandlers } from './source-control/filesystem-git-commit-handlers'
import { registerFilesystemGitCommitGenerationHandlers } from './source-control/filesystem-git-commit-generation-handlers'
import { registerFilesystemGitModelDiscoveryHandlers } from './source-control/filesystem-git-model-discovery-handlers'
import { registerFilesystemGitPullRequestGenerationHandlers } from './source-control/filesystem-git-pull-request-generation-handlers'
import { registerFilesystemGitRemoteHandlers } from './git-remote/filesystem-git-remote-handlers'
import { registerFilesystemGitDiffHandlers } from './source-control/filesystem-git-diff-handlers'
import { registerFilesystemGitIndexHandlers } from './source-control/filesystem-git-index-handlers'
import { registerFilesystemGitUrlHandlers } from './source-control/filesystem-git-url-handlers'

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
