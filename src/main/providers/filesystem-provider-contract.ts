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

export type FileRangeReadResult = {
  /** Raw bytes for `[position, position + bytesRead)`. `bytesRead < length`
   *  always means end of file: the host loops until the window is filled, and
   *  an over-cap request is rejected rather than clamped, so a short read is
   *  never a partial syscall or a silently narrowed window. A `position` at or
   *  past EOF yields `bytesRead === 0`. */
  bytes: Buffer
  bytesRead: number
}

/** Thrown by `readFileRange` when the host cannot serve a positional read.
 *  Callers that tail a file should probe `supportsFileRangeRead()` once and
 *  fall back to a single whole-file snapshot, NOT to a whole-file read per
 *  chunk -- that is quadratic on a growing file. */
export class FileRangeReadUnsupportedError extends Error {
  constructor(message = 'Positional file reads are unavailable on this host') {
    super(message)
    this.name = 'FileRangeReadUnsupportedError'
  }
}

export type IFilesystemProvider = {
  readDir(dirPath: string): Promise<DirEntry[]>
  readFile(filePath: string, limits?: FileReadLimits): Promise<FileReadResult>
  /** Positional read. Optional because an older remote host cannot serve one.
   *  Strict by design: it throws `FileRangeReadUnsupportedError` rather than
   *  silently degrading, so a caller cannot accidentally pay a whole-file
   *  transfer per chunk while tailing.
   *
   *  `position` must be a non-negative safe integer and `length` a positive one
   *  no larger than `MAX_FILE_RANGE_READ_BYTES`; anything else throws
   *  `FileRangeReadRequestError` without reaching the host. The final byte
   *  offset must also remain a safe integer. */
  readFileRange?(
    filePath: string,
    position: number,
    length: number,
    options?: { signal?: AbortSignal }
  ): Promise<FileRangeReadResult>
  /** Cached capability probe for `readFileRange`. */
  supportsFileRangeRead?(options?: { signal?: AbortSignal }): Promise<boolean>
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
