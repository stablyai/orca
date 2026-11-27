import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

const FILESYSTEM_DOWNLOAD_CHANNELS = [
  'fs:downloadFile',
  'fs:downloadFolder',
  'fs:saveDownloadedFile',
  'fs:startDownloadedFile',
  'fs:appendDownloadedFileChunk',
  'fs:finishDownloadedFile',
  'fs:cancelDownloadedFile'
] as const

const FILESYSTEM_GIT_COMMIT_GENERATION_CHANNELS = [
  'git:generateCommitMessage',
  'git:cancelGenerateCommitMessage'
] as const

const FILESYSTEM_GIT_MODEL_DISCOVERY_CHANNELS = ['git:discoverCommitMessageModels'] as const

const FILESYSTEM_GIT_PR_GENERATION_CHANNELS = [
  'git:generatePullRequestFields',
  'git:cancelGeneratePullRequestFields'
] as const

const FILESYSTEM_GIT_URL_CHANNELS = ['git:remoteFileUrl', 'git:remoteCommitUrl'] as const

function clearChannels(channels: readonly string[]): void {
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }
}

export function registerLazyFilesystemSecondaryHandlers(context: FilesystemHandlerContext): void {
  clearChannels(FILESYSTEM_DOWNLOAD_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_DOWNLOAD_CHANNELS, async (ipc) => {
    const { registerFilesystemDownloadHandlers } =
      await import('./downloads/filesystem-download-handlers')
    registerFilesystemDownloadHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_COMMIT_GENERATION_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_COMMIT_GENERATION_CHANNELS, async (ipc) => {
    const { registerFilesystemGitCommitGenerationHandlers } =
      await import('./source-control/filesystem-git-commit-generation-handlers')
    registerFilesystemGitCommitGenerationHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_MODEL_DISCOVERY_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_MODEL_DISCOVERY_CHANNELS, async (ipc) => {
    const { registerFilesystemGitModelDiscoveryHandlers } =
      await import('./source-control/filesystem-git-model-discovery-handlers')
    registerFilesystemGitModelDiscoveryHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_PR_GENERATION_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_PR_GENERATION_CHANNELS, async (ipc) => {
    const { registerFilesystemGitPullRequestGenerationHandlers } =
      await import('./source-control/filesystem-git-pull-request-generation-handlers')
    registerFilesystemGitPullRequestGenerationHandlers(context, ipc)
  })

  clearChannels(FILESYSTEM_GIT_URL_CHANNELS)
  registerLazyIpcHandleGroup(FILESYSTEM_GIT_URL_CHANNELS, async (ipc) => {
    const { registerFilesystemGitUrlHandlers } =
      await import('./source-control/filesystem-git-url-handlers')
    registerFilesystemGitUrlHandlers(context, ipc)
  })
}
