import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import type { DirEntry, FsChangeEvent } from '../../shared/filesystem-entry-types'
import type { WorkspaceSpaceDirectoryScanResult } from '../../shared/workspace-space-types'

export type FileStat = {
  size: number
  type: 'file' | 'directory' | 'symlink'
  mtime: number
  mtimeMs?: number
  dev?: number
  ino?: number
  nlink?: number
}

export type FileReadResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

export type FileReadLimits = {
  maxBinaryBytes?: number
  maxTextBytes?: number
}

export type IFilesystemProvider = {
  readDir(dirPath: string): Promise<DirEntry[]>
  readFile(filePath: string, limits?: FileReadLimits): Promise<FileReadResult>
  readTerminalArtifact?(
    filePath: string,
    options: TerminalArtifactAccessOptions
  ): Promise<FileReadResult>
  downloadFile?(sourcePath: string, destinationPath: string): Promise<void>
  downloadFolder?: (src: string, dest: string, options?: { signal?: AbortSignal }) => Promise<void>
  openFileUploadSession?(): Promise<FileUploadSession>
  getTempDir?(): Promise<string>
  writeFile(filePath: string, content: string): Promise<void>
  writeTerminalArtifact?(
    filePath: string,
    content: string,
    options: TerminalArtifactAccessOptions
  ): Promise<FileStat>
  writeFileBase64(filePath: string, contentBase64: string): Promise<void>
  writeFileBase64Chunk(filePath: string, contentBase64: string, append: boolean): Promise<void>
  stat(filePath: string): Promise<FileStat>
  lstat?(filePath: string): Promise<FileStat>
  deletePath(targetPath: string, recursive?: boolean): Promise<void>
  createFile(filePath: string): Promise<void>
  createDir(dirPath: string): Promise<void>
  createDirNoClobber(dirPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  renameNoClobber(oldPath: string, newPath: string): Promise<void>
  copy(source: string, destination: string): Promise<void>
  realpath(filePath: string): Promise<string>
  search(opts: SearchOptions): Promise<SearchResult>
  listFiles(
    rootPath: string,
    options?: {
      excludePaths?: string[]
      signal?: AbortSignal
      maxResults?: number
      searchQuery?: string
    }
  ): Promise<string[]>
  supportsQuickOpenSearch?(options?: { signal?: AbortSignal }): Promise<boolean>
  scanWorkspaceSpace?(
    rootPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceSpaceDirectoryScanResult>
  watch(
    rootPath: string,
    callback: (events: FsChangeEvent[]) => void,
    options?: { signal?: AbortSignal; onTerminalError?: (error: Error) => void }
  ): Promise<() => void>
  closeWatch?(rootPath: string): Promise<void>
}

export type FileUploadSession = {
  uploadFile(
    sourcePath: string,
    destinationPath: string,
    options?: { exclusive?: boolean }
  ): Promise<void>
  close(): void
}

export type TerminalArtifactAccessOptions = {
  expectedRealPath: string
  expectedStatIdentity: string | null
  maxBytes: number
}
