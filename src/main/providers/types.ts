import type {
  DirEntry,
  FsChangeEvent,
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitConflictOperation,
  GitWorktreeInfo,
  SearchOptions,
  SearchResult
} from '../../shared/types'

// ─── PTY Provider ───────────────────────────────────────────────────

export type PtySpawnOptions = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
  /** Orca worktree identity. When present, the local provider scopes shell
   *  history to this worktree so ArrowUp only surfaces local commands. */
  worktreeId?: string
  /** Daemon session ID for reattach. When provided, the daemon reconnects
   *  to an existing session instead of creating a new one. */
  sessionId?: string
}

export type PtySpawnResult = {
  id: string
  /** ANSI snapshot of the terminal screen, present when reattaching to an
   *  existing daemon session. Write this to xterm.js to restore visual state. */
  snapshot?: string
  /** Dimensions the snapshot was captured at. Resize xterm.js to these before
   *  writing the snapshot so ANSI cursor positions land correctly. */
  snapshotCols?: number
  snapshotRows?: number
  /** True when the spawn reattached to an existing daemon session. */
  isReattach?: boolean
  /** True when the reattached session uses the alternate screen buffer
   *  (e.g., Codex CLI, vim). Normal-screen TUIs like Claude Code are false. */
  isAlternateScreen?: boolean
  /** Present when cold-restoring from disk history after a daemon crash.
   *  Contains the saved scrollback and CWD. The new shell spawns in the
   *  saved CWD; the scrollback is written to xterm.js as read-only history. */
  coldRestore?: {
    scrollback: string
    cwd: string
  }
}

export type IPtyProvider = {
  spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>
  attach(id: string): Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  shutdown(id: string, immediate: boolean): Promise<void>
  sendSignal(id: string, signal: string): Promise<void>
  getCwd(id: string): Promise<string>
  getInitialCwd(id: string): Promise<string>
  clearBuffer(id: string): Promise<void>
  acknowledgeDataEvent(id: string, charCount: number): void
  hasChildProcesses(id: string): Promise<boolean>
  getForegroundProcess(id: string): Promise<string | null>
  serialize(ids: string[]): Promise<string>
  revive(state: string): Promise<void>
  listProcesses(): Promise<{ id: string; cwd: string; title: string }[]>
  getDefaultShell(): Promise<string>
  getProfiles(): Promise<{ name: string; path: string }[]>
  onData(callback: (payload: { id: string; data: string }) => void): () => void
  onReplay(callback: (payload: { id: string; data: string }) => void): () => void
  onExit(callback: (payload: { id: string; code: number }) => void): () => void
}

// ─── Filesystem Provider ────────────────────────────────────────────

export type FileStat = {
  size: number
  type: 'file' | 'directory' | 'symlink'
  mtime: number
}

export type FileReadResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

export type IFilesystemProvider = {
  readDir(dirPath: string): Promise<DirEntry[]>
  readFile(filePath: string): Promise<FileReadResult>
  writeFile(filePath: string, content: string): Promise<void>
  stat(filePath: string): Promise<FileStat>
  deletePath(targetPath: string): Promise<void>
  createFile(filePath: string): Promise<void>
  createDir(dirPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  copy(source: string, destination: string): Promise<void>
  realpath(filePath: string): Promise<string>
  search(opts: SearchOptions): Promise<SearchResult>
  listFiles(rootPath: string): Promise<string[]>
  watch(rootPath: string, callback: (events: FsChangeEvent[]) => void): Promise<() => void>
}

// ─── Git Provider ───────────────────────────────────────────────────

export type IGitProvider = {
  getStatus(worktreePath: string): Promise<GitStatusResult>
  getDiff(worktreePath: string, filePath: string, staged: boolean): Promise<GitDiffResult>
  stageFile(worktreePath: string, filePath: string): Promise<void>
  unstageFile(worktreePath: string, filePath: string): Promise<void>
  bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  discardChanges(worktreePath: string, filePath: string): Promise<void>
  detectConflictOperation(worktreePath: string): Promise<GitConflictOperation>
  getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult>
  getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
  ): Promise<GitDiffResult[]>
  listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>
  addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; track?: boolean }
  ): Promise<void>
  removeWorktree(worktreePath: string, force?: boolean): Promise<void>
  isGitRepo(path: string): boolean
  isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }>
  exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
  getRemoteFileUrl(worktreePath: string, relativePath: string, line: number): Promise<string | null>
}

// ─── Provider Registry ──────────────────────────────────────────────

/**
 * Routes operations to the correct provider based on connectionId.
 * null/undefined connectionId = local provider.
 */
export type IProviderRegistry = {
  getPtyProvider(connectionId: string | null | undefined): IPtyProvider
  getFilesystemProvider(connectionId: string | null | undefined): IFilesystemProvider
  getGitProvider(connectionId: string | null | undefined): IGitProvider
}
