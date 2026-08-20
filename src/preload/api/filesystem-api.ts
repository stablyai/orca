import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type {
  DirEntry,
  FsChangedPayload,
  MarkdownDocument
} from '../../shared/filesystem-entry-types'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../../shared/local-log-tail-types'
import type { SshMutationExpectation } from '../../shared/ssh-types'

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
    authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
    stat: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
    pathExists: (args: { filePath: string; connectionId?: string }) => Promise<boolean>
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
      requestToken?: string
      maxResults?: number
      searchQuery?: string
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
    ) => Promise<{
      results: (
        | {
            sourcePath: string
            status: 'imported'
            destPath: string
            kind: 'file' | 'directory'
            renamed: boolean
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }>
    stageExternalPathsForRuntimeUpload: (args: { sourcePaths: string[] }) => Promise<{
      sources: (
        | {
            sourcePath: string
            status: 'staged'
            name: string
            kind: 'file' | 'directory'
            entries: (
              | { relativePath: string; kind: 'directory' }
              | { relativePath: string; kind: 'file'; contentBase64: string }
            )[]
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }>
    resolveDroppedPathsForAgent: (
      args: {
        paths: string[]
        worktreePath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<{
      resolvedPaths: string[]
      skipped: {
        sourcePath: string
        reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
      }[]
      failed: { sourcePath: string; reason: string }[]
    }>
    watchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    unwatchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    onFsChanged: (callback: (payload: FsChangedPayload) => void) => () => void
  }
  notebook: {
    runPythonCell: (args: {
      filePath: string
      code: string
      preamble?: string
      connectionId?: string | null
    }) => Promise<{
      stdout: string
      stderr: string
      exitCode: number | null
      error?: string
    }>
  }
  export: ExportApi
}
