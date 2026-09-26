import type { PathExistenceResult } from '../../shared/path-existence-batch'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type {
  DirEntry,
  FsChangedPayload,
  MarkdownDocument
} from '../../shared/filesystem-entry-types'
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
import type { SshMutationExpectation } from '../../shared/ssh-types'
import type {
  CreateVenvResult,
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironment,
  PythonEnvironments
} from '../../shared/notebook-kernel-types'
import type { RuntimeUploadFileStreamRequest } from '../../shared/runtime-upload-staging-contract'

export type ExportApi = {
  htmlToPdf: (args: {
    html: string
    title: string
  }) => Promise<
    { success: true; filePath: string } | { success: false; cancelled?: boolean; error?: string }
  >
}

export type FilesystemApi = {
  fs: {
    readDir: (args: { dirPath: string; connectionId?: string }) => Promise<DirEntry[]>
    readFile: (args: {
      filePath: string
      connectionId?: string
      includeLocalLogMetadata?: boolean
    }) => Promise<{
      content: string
      isBinary: boolean
      isImage?: boolean
      mimeType?: string
      fileIdentity?: string
    }>
    readLocalLogTail: (args: LocalLogTailReadArgs) => Promise<LocalLogTailReadResult>
    startLocalLogTail: (args: LocalLogTailWatchArgs) => Promise<void>
    stopLocalLogTail: (args: { subscriptionId: string }) => Promise<void>
    onLocalLogTailChanged: (callback: (payload: LocalLogTailChangedPayload) => void) => () => void
    downloadFile: (args: {
      filePath: string
      connectionId: string
    }) => Promise<{ canceled: true } | { canceled: false; destinationPath: string }>
    downloadFolder: (args: {
      dirPath: string
      connectionId: string
    }) => Promise<{ canceled: true } | { canceled: false; destinationPath: string }>
    saveDownloadedFile: (args: {
      suggestedName: string
      content: string
      encoding: 'utf8' | 'base64'
    }) => Promise<{ canceled: true } | { canceled: false; destinationPath: string }>
    startDownloadedFile: (args: {
      suggestedName: string
    }) => Promise<
      { canceled: true } | { canceled: false; transferId: string; destinationPath: string }
    >
    appendDownloadedFileChunk: (args: {
      transferId: string
      contentBase64: string
    }) => Promise<{ ok: true }>
    finishDownloadedFile: (args: {
      transferId: string
    }) => Promise<{ canceled: false; destinationPath: string }>
    cancelDownloadedFile: (args: { transferId: string }) => Promise<{ ok: true }>
    listMarkdownDocuments: (args: {
      rootPath: string
      connectionId?: string
    }) => Promise<MarkdownDocument[]>
    writeFile: (
      args: {
        filePath: string
        content: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<void>
    createFile: (
      args: {
        filePath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<void>
    createDir: (
      args: { dirPath: string; connectionId?: string } & SshMutationExpectation
    ) => Promise<void>
    rename: (
      args: {
        oldPath: string
        newPath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<void>
    copy: (
      args: {
        sourcePath: string
        destinationPath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<void>
    deletePath: (
      args: {
        targetPath: string
        connectionId?: string
        recursive?: boolean
      } & SshMutationExpectation
    ) => Promise<void>
    grantExternalFile: (args: { targetPath: string }) => Promise<void>
    grantExternalDirectory: (args: { targetPath: string }) => Promise<void>
    stat: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
    pathsExist?: (args: {
      filePaths: string[]
      connectionId?: string
    }) => Promise<PathExistenceResult[]>
    pathExists: (args: { filePath: string; connectionId?: string }) => Promise<boolean>
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
      requestToken?: string
      maxResults?: number
      searchQuery?: string
      nameFilter?: string
    }) => Promise<string[]>
    cancelListFiles: (args: { requestToken: string }) => Promise<void>
    search: (args: SearchOptions & { connectionId?: string }) => Promise<SearchResult>
    importExternalPaths: (
      args: {
        sourcePaths: string[]
        destDir: string
        connectionId?: string
        ensureDir?: boolean
      } & SshMutationExpectation
    ) => Promise<{ results: ImportItemResult[] }>
    stageExternalPathsForRuntimeUpload: (args: {
      sourcePaths: string[]
    }) => Promise<{ sources: StagedExternalImportSource[] }>
    uploadExternalFileToRuntime: (
      args: RuntimeUploadFileStreamRequest
    ) => Promise<{ byteLength: number }>
    resolveDroppedPathsForAgent: (
      args: {
        paths: string[]
        worktreePath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<ResolveDroppedPathsResult>
    watchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    unwatchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    onFsChanged: (callback: (payload: FsChangedPayload) => void) => () => void
  }
  notebook: {
    listPythonEnvironments: (args: {
      filePath: string
      rootPath: string | null
      /** False until the notebook is trusted: workspace envs are then listed without running them. */
      runWorkspaceInterpreters: boolean
    }) => Promise<PythonEnvironments>
    describePython: (args: { path: string }) => Promise<PythonEnvironment | null>
    startKernel: (args: { filePath: string; python: string }) => Promise<KernelStartResult>
    installIpykernel: (args: { python: string }) => Promise<{ ok: boolean; detail: string }>
    createVenv: (args: {
      filePath: string
      rootPath: string | null
      python: string
    }) => Promise<CreateVenvResult>
    execute: (args: { filePath: string; code: string }) => Promise<void>
    interrupt: (args: { filePath: string }) => Promise<void>
    shutdownKernel: (args: { filePath: string }) => Promise<void>
    onKernelFrame: (callback: (event: KernelFrameEvent) => void) => () => void
  }
  export: ExportApi
}
