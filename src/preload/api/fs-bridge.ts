import type { PathExistenceResult } from '../../shared/path-existence-batch'
import { ipcRenderer } from 'electron'
import type { SshMutationExpectation } from '../../shared/ssh-types'
import type { RuntimeUploadFileStreamRequest } from '../../shared/runtime-upload-staging-contract'
import type { SearchResult } from '../../shared/code-search-types'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import type {
  ImportItemResult,
  ResolveDroppedPathsResult,
  StagedExternalImportSource
} from '../../shared/filesystem-import-result-types'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../../shared/local-log-tail-types'
import type { PreloadApi } from '../api-types'

export const fsApi = {
  readDir: (args: {
    dirPath: string
    connectionId?: string
  }): Promise<{ name: string; isDirectory: boolean; isSymlink: boolean }[]> =>
    ipcRenderer.invoke('fs:readDir', args),
  readFile: (args: {
    filePath: string
    connectionId?: string
    includeLocalLogMetadata?: boolean
  }): Promise<{
    content: string
    isBinary: boolean
    isImage?: boolean
    mimeType?: string
    fileIdentity?: string
  }> => ipcRenderer.invoke('fs:readFile', args),
  readLocalLogTail: (args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> =>
    ipcRenderer.invoke('fs:readLocalLogTail', args),
  startLocalLogTail: (args: LocalLogTailWatchArgs): Promise<void> =>
    ipcRenderer.invoke('fs:startLocalLogTail', args),
  stopLocalLogTail: (args: { subscriptionId: string }): Promise<void> =>
    ipcRenderer.invoke('fs:stopLocalLogTail', args),
  onLocalLogTailChanged: (
    callback: (payload: LocalLogTailChangedPayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: LocalLogTailChangedPayload
    ): void => callback(payload)
    ipcRenderer.on('fs:localLogTailChanged', listener)
    return () => ipcRenderer.removeListener('fs:localLogTailChanged', listener)
  },
  downloadFile: (args: {
    filePath: string
    connectionId: string
  }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
    ipcRenderer.invoke('fs:downloadFile', args),
  downloadFolder: (args: {
    dirPath: string
    connectionId: string
  }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
    ipcRenderer.invoke('fs:downloadFolder', args),
  saveDownloadedFile: (args: {
    suggestedName: string
    content: string
    encoding: 'utf8' | 'base64'
  }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
    ipcRenderer.invoke('fs:saveDownloadedFile', args),
  startDownloadedFile: (args: {
    suggestedName: string
  }): Promise<
    { canceled: true } | { canceled: false; transferId: string; destinationPath: string }
  > => ipcRenderer.invoke('fs:startDownloadedFile', args),
  appendDownloadedFileChunk: (args: {
    transferId: string
    contentBase64: string
  }): Promise<{ ok: true }> => ipcRenderer.invoke('fs:appendDownloadedFileChunk', args),
  finishDownloadedFile: (args: {
    transferId: string
  }): Promise<{ canceled: false; destinationPath: string }> =>
    ipcRenderer.invoke('fs:finishDownloadedFile', args),
  cancelDownloadedFile: (args: { transferId: string }): Promise<{ ok: true }> =>
    ipcRenderer.invoke('fs:cancelDownloadedFile', args),
  listMarkdownDocuments: (args: {
    rootPath: string
    connectionId?: string
  }): Promise<{ filePath: string; relativePath: string; basename: string; name: string }[]> =>
    ipcRenderer.invoke('fs:listMarkdownDocuments', args),
  writeFile: (
    args: {
      filePath: string
      content: string
      connectionId?: string
    } & SshMutationExpectation
  ): Promise<void> => ipcRenderer.invoke('fs:writeFile', args),
  createFile: (
    args: { filePath: string; connectionId?: string } & SshMutationExpectation
  ): Promise<void> => ipcRenderer.invoke('fs:createFile', args),
  createDir: (
    args: { dirPath: string; connectionId?: string } & SshMutationExpectation
  ): Promise<void> => ipcRenderer.invoke('fs:createDir', args),
  rename: (
    args: { oldPath: string; newPath: string; connectionId?: string } & SshMutationExpectation
  ): Promise<void> => ipcRenderer.invoke('fs:rename', args),
  copy: (
    args: {
      sourcePath: string
      destinationPath: string
      connectionId?: string
    } & SshMutationExpectation
  ): Promise<void> => ipcRenderer.invoke('fs:copy', args),
  deletePath: (
    args: {
      targetPath: string
      connectionId?: string
      recursive?: boolean
    } & SshMutationExpectation
  ): Promise<void> => ipcRenderer.invoke('fs:deletePath', args),
  authorizeExternalPath: (args: { targetPath: string }): Promise<void> =>
    ipcRenderer.invoke('fs:authorizeExternalPath', args),
  stat: (args: {
    filePath: string
    connectionId?: string
  }): Promise<{ size: number; isDirectory: boolean; mtime: number }> =>
    ipcRenderer.invoke('fs:stat', args),
  pathsExist: (args: {
    filePaths: string[]
    connectionId?: string
  }): Promise<PathExistenceResult[]> => ipcRenderer.invoke('fs:pathsExist', args),
  pathExists: (args: { filePath: string; connectionId?: string }): Promise<boolean> =>
    ipcRenderer.invoke('fs:pathExists', args),
  listFiles: (args: {
    rootPath: string
    connectionId?: string
    excludePaths?: string[]
    requestToken?: string
    maxResults?: number
    searchQuery?: string
    nameFilter?: string
  }): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', args),
  cancelListFiles: (args: { requestToken: string }): Promise<void> =>
    ipcRenderer.invoke('fs:cancelListFiles', args),
  search: (args: {
    query: string
    rootPath: string
    caseSensitive?: boolean
    wholeWord?: boolean
    useRegex?: boolean
    includePattern?: string
    excludePattern?: string
    maxResults?: number
    connectionId?: string
  }): Promise<SearchResult> => ipcRenderer.invoke('fs:search', args),
  importExternalPaths: (
    args: {
      sourcePaths: string[]
      destDir: string
      connectionId?: string
      ensureDir?: boolean
    } & SshMutationExpectation
  ): Promise<{ results: ImportItemResult[] }> => ipcRenderer.invoke('fs:importExternalPaths', args),
  stageExternalPathsForRuntimeUpload: (args: {
    sourcePaths: string[]
  }): Promise<{ sources: StagedExternalImportSource[] }> =>
    ipcRenderer.invoke('fs:stageExternalPathsForRuntimeUpload', args),
  uploadExternalFileToRuntime: (
    args: RuntimeUploadFileStreamRequest
  ): Promise<{ byteLength: number }> => ipcRenderer.invoke('fs:uploadExternalFileToRuntime', args),
  onUploadProgress: (
    callback: (progress: { uploadId: string; sentBytes: number; totalBytes: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { uploadId: string; sentBytes: number; totalBytes: number }
    ) => callback(data)
    ipcRenderer.on('fs:uploadProgress', listener)
    return () => ipcRenderer.removeListener('fs:uploadProgress', listener)
  },
  cancelRuntimeUpload: (args: { uploadId: string }): Promise<void> =>
    ipcRenderer.invoke('fs:cancelRuntimeUpload', args),
  releaseRuntimeUpload: (args: { uploadId: string }): Promise<void> =>
    ipcRenderer.invoke('fs:releaseRuntimeUpload', args),
  resolveDroppedPathsForAgent: (
    args: {
      paths: string[]
      worktreePath: string
      connectionId?: string
    } & SshMutationExpectation
  ): Promise<ResolveDroppedPathsResult> =>
    ipcRenderer.invoke('fs:resolveDroppedPathsForAgent', args),
  watchWorktree: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
    ipcRenderer.invoke('fs:watchWorktree', args),
  unwatchWorktree: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
    ipcRenderer.invoke('fs:unwatchWorktree', args),
  onFsChanged: (callback: (payload: FsChangedPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FsChangedPayload) =>
      callback(payload)
    ipcRenderer.on('fs:changed', listener)
    return () => ipcRenderer.removeListener('fs:changed', listener)
  }
} satisfies PreloadApi['fs']
