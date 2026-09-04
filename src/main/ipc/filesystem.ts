import type { Store } from '../persistence'
import type { DirEntry, MarkdownDocument } from '../../shared/filesystem-entry-types'
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../shared/git-diff-compare-types'
import type { GitForkSyncExpectedUpstream, GitForkSyncResult } from '../../shared/git-fork-sync'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus
} from '../../shared/git-status-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import type { SshMutationExpectation } from '../../shared/ssh-types'
import { sortDirEntries } from '../../shared/file-name-sort'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import {
  getStatus,
  getSubmoduleStatus,
  abortMerge,
  abortRebase,
  detectConflictOperation,
  getDiff,
  commitChanges,
  stageFile,
  unstageFile,
  bulkStageFiles,
  bulkUnstageFiles,
  bulkDiscardChanges,
  discardChanges,
  getStagedCommitContext,
  getBranchCompare,
  getBranchDiff,
  getCommitCompare,
  getCommitDiff
} from '../git/status'
import { getHistory } from '../git/history'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings,
  type DiscoverCommitMessageModelsResult,
  type CommitMessageGenerationTarget,
  type GenerateCommitMessageResult,
  type GeneratePullRequestFieldsResult
} from '../text-generation/commit-message-text-generation'
import { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import { getUpstreamStatus } from '../git/upstream'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from '../git/remote'
import { gitSyncForkDefaultBranch } from '../git/fork-sync'
import { validateGitForkSyncExpectedUpstream } from '../../shared/git-fork-sync'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import {
  appendFolderToGitignore,
  findKnownHugeFolderPathsToIgnore
} from '../git/huge-folder-ignore'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import type { HostedReviewProvider } from '../../shared/hosted-review'
import { normalizeSourceControlAiSettings, type ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { withLinkedIssueDraftContext } from '../../shared/source-control-ai-action-variables'
import { validateGitPushTarget } from '../git/push-target-validation'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../git/repo'
import { resolveAuthorizedPath, authorizeExternalPath } from './filesystem-auth'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'
import { validateGitRelativeFilePath, isENOENT } from './filesystem-path-containment'
import { listQuickOpenFiles } from './filesystem-list-files'
import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import { searchWithGitGrep } from './filesystem-search-git'
import {
  getLocalGitOptionsForRegisteredWorktree,
  getLocalGitOptionsForRepo,
  getLocalRepoForRegisteredWorktree
} from './local-worktree-runtime-options'
import {
  resolveSourceControlAiLinkedIssue,
  resolveSourceControlAiLinkedIssueMeta
} from './source-control-ai-linked-issue'
import { listMarkdownDocuments, markdownDocumentsFromRelativePaths } from './markdown-documents'
import { checkRgAvailable } from './rg-availability'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableExit,
  killSpawnedRipgrepProcess
} from '../../shared/ripgrep-process-availability'
import {
  getSshFilesystemProvider,
  requireSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { resolveHostedReviewBodyForGeneration } from '../source-control/pull-request-template'
import { loadPullRequestLinkedIssue } from '../source-control/pull-request-linked-issue'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentRuntimeTarget,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import { listRepoWorktrees } from '../repo-worktrees'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { buildReadDirErrorBreadcrumb, type ReadDirThrowSite } from './readdir-error-diagnostics'
import { splitWorktreeId } from '../../shared/worktree/id'
import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
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

