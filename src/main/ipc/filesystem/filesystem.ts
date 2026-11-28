import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import { createSenderScopedRequestCancellations } from '../renderer-requests/sender-scoped-request-cancellation'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import {
  createFilesystemHandlerContext,
  type FilesystemHandlerContext
} from './filesystem-handler-context'
import { registerFilesystemReadHandlers } from './reads/filesystem-read-handlers'
import { registerFilesystemGitStatusHandlers } from './source-control/filesystem-git-status-handlers'
import { registerLazyFilesystemSecondaryHandlers } from './lazy-filesystem-secondary-handlers'

const FILESYSTEM_WRITE_CHANNELS = [
  'fs:writeFile',
  'fs:writeFileBytes',
  'fs:deletePath',
  'fs:createFile',
  'fs:createDir',
  'fs:rename',
  'fs:copy',
  'fs:importExternalPaths',
  'fs:stageExternalPathsForRuntimeUpload',
  'fs:uploadExternalFileToRuntime',
  'fs:resolveDroppedPathsForAgent',
  'fs:uploadPathsToAgentSessionAttachments'
] as const
const FILESYSTEM_SEARCH_CHANNELS = ['fs:listFiles', 'fs:cancelListFiles'] as const
const FILESYSTEM_CONTENT_SEARCH_CHANNELS = ['fs:search', 'fs:cancelSearch'] as const
const FILESYSTEM_GIT_COMMIT_CHANNELS = [
  'git:createBranch',
  'git:sequencerAbort',
  'git:sequencerContinue',
  'git:cherryPick',
  'git:revert',
  'git:commit',
  'git:completeMerge'
] as const
const FILESYSTEM_GIT_REMOTE_CHANNELS = [
  'git:branchCompare',
  'git:commitCompare',
  'git:upstreamStatus',
  'git:fetch',
  'git:syncFork',
  'git:push',
  'git:pull',
  'git:fastForward',
  'git:rebaseFromBase'
] as const
const FILESYSTEM_GIT_DIFF_CHANNELS = ['git:branchDiff', 'git:commitDiff'] as const
const FILESYSTEM_GIT_INDEX_CHANNELS = [
  'git:stage',
  'git:resolveConflict',
  'git:unstage',
  'git:discard',
  'git:bulkDiscard',
  'git:bulkStage',
  'git:bulkUnstage'
] as const
const LOCAL_LOG_TAIL_CHANNELS = [
  'fs:readLocalLogTail',
  'fs:startLocalLogTail',
  'fs:stopLocalLogTail'
] as const

function clearChannels(channels: readonly string[]): void {
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }
}

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
  registerFilesystemGitStatusHandlers(context)

  clearChannels(FILESYSTEM_WRITE_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_WRITE_CHANNELS, async (ipc) => {
    const { registerFilesystemWriteHandlers } =
      await import('./mutations/filesystem-write-handlers')
    registerFilesystemWriteHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_SEARCH_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_SEARCH_CHANNELS, async (ipc) => {
    const { registerFilesystemSearchHandlers } = await import('./search/filesystem-search-handlers')
    registerFilesystemSearchHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_CONTENT_SEARCH_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_CONTENT_SEARCH_CHANNELS, async (ipc) => {
    const { registerFilesystemContentSearchHandler } =
      await import('./search/filesystem-content-search-handler')
    registerFilesystemContentSearchHandler(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_COMMIT_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_COMMIT_CHANNELS, async (ipc) => {
    const { registerFilesystemGitCommitHandlers } =
      await import('./source-control/filesystem-git-commit-handlers')
    registerFilesystemGitCommitHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_REMOTE_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_REMOTE_CHANNELS, async (ipc) => {
    const { registerFilesystemGitRemoteHandlers } =
      await import('./git-remote/filesystem-git-remote-handlers')
    registerFilesystemGitRemoteHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_DIFF_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_DIFF_CHANNELS, async (ipc) => {
    const { registerFilesystemGitDiffHandlers } =
      await import('./source-control/filesystem-git-diff-handlers')
    registerFilesystemGitDiffHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_INDEX_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_INDEX_CHANNELS, async (ipc) => {
    const { registerFilesystemGitIndexHandlers } =
      await import('./source-control/filesystem-git-index-handlers')
    registerFilesystemGitIndexHandlers(context, ipc)
  })

  registerLazyFilesystemSecondaryHandlers(context)

  clearChannels(LOCAL_LOG_TAIL_CHANNELS)
  registerLazyIpcHandleGroup(LOCAL_LOG_TAIL_CHANNELS, async (ipc) => {
    const { registerLocalLogTailHandlers } = await import('./reads/local-log-tail')
    registerLocalLogTailHandlers(store, ipc)
  })
}
