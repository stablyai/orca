import type {
  DirEntry,
  FsChangeEvent,
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitPushTarget,
  GitUpstreamStatus,
  GitWorktreeInfo,
  SearchOptions,
  SearchResult
} from '../../shared/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { WorkspaceSpaceDirectoryScanResult } from '../../shared/workspace-space-types'

// ─── PTY Provider ───────────────────────────────────────────────────

export type PtySpawnOptions = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  /** Orca worktree identity. When present, the local provider scopes shell
   *  history to this worktree so ArrowUp only surfaces local commands. */
  worktreeId?: string
  /** Daemon session ID. A caller-provided ID is treated as an attach request;
   *  daemon hosts also pass minted IDs for fresh sessions that need stable
   *  per-PTY state before provider.spawn returns. */
  sessionId?: string
  /** True when the caller minted this daemon session for a fresh terminal.
   *  Existing-session attach paths must stay false so recovery checks do not
   *  replace the daemon out from under a still-live PTY. */
  isNewSession?: boolean
  /** Why: allows the renderer to request a specific shell for a single new
   *  terminal tab (e.g. "open this tab in WSL" from the "+" submenu) without
   *  changing the user's persistent default shell setting. Only consulted on
   *  Windows; ignored on macOS/Linux where shell selection is not exposed. */
  shellOverride?: string
  /** Preferred WSL distro for generic `wsl.exe` launches. Worktree/session
   *  distro still wins when the cwd already identifies a WSL distro. */
  terminalWindowsWslDistro?: string | null
  /** Why: PowerShell is the top-level shell family in product terms, but on
   *  Windows we may need to choose between inbox Windows PowerShell 5.1 and
   *  pwsh.exe at spawn time. Threading the persisted implementation choice
   *  through spawn options keeps local PTY and daemon PTY semantics aligned
   *  without promoting pwsh into a separate shell family. */
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
}

export type PtySpawnResult = {
  /** App-facing PTY id. Remote providers must return globally routable ids,
   *  not relay-local handles, because renderer/runtime IPC routes by this key. */
  id: string
  /** OS-level pid of the shell process, when available at spawn time.
   *  Why: the memory collector needs this to walk each PTY's process
   *  subtree. Daemon-backed providers return it from the RPC result;
   *  local providers read it from node-pty. Null when the underlying
   *  provider could not publish a pid (e.g., race during spawn). */
  pid?: number | null
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
  /** Buffered output returned by relay pty.attach. Unlike snapshot, this is
   *  incremental scrollback and must not clear the terminal before replay. */
  replay?: string
  /** True when the caller requested reattach (sessionId was provided) but the
   *  relay PTY was gone (grace window elapsed). The renderer uses this to show
   *  a brief "Session expired — new shell started" message. */
  sessionExpired?: boolean
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
  hasPty?: (id: string) => boolean
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void>
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
  getTempDir?(): Promise<string>
  writeFile(filePath: string, content: string): Promise<void>
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
  listFiles(rootPath: string, options?: { excludePaths?: string[] }): Promise<string[]>
  scanWorkspaceSpace?(
    rootPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceSpaceDirectoryScanResult>
  watch(rootPath: string, callback: (events: FsChangeEvent[]) => void): Promise<() => void>
}

// ─── Git Provider ───────────────────────────────────────────────────

export type IGitProvider = {
  getStatus(worktreePath: string, options?: { includeIgnored?: boolean }): Promise<GitStatusResult>
  checkIgnoredPaths(worktreePath: string, relativePaths: string[]): Promise<string[]>
  getHistory(worktreePath: string, options?: GitHistoryOptions): Promise<GitHistoryResult>
  commit(worktreePath: string, message: string): Promise<{ success: boolean; error?: string }>
  getStagedCommitContext(worktreePath: string): Promise<CommitMessageDraftContext | null>
  getDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean
  ): Promise<GitDiffResult>
  stageFile(worktreePath: string, filePath: string): Promise<void>
  unstageFile(worktreePath: string, filePath: string): Promise<void>
  bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void>
  discardChanges(worktreePath: string, filePath: string): Promise<void>
  bulkDiscardChanges(worktreePath: string, filePaths: string[]): Promise<void>
  detectConflictOperation(worktreePath: string): Promise<GitConflictOperation>
  abortMerge(worktreePath: string): Promise<void>
  abortRebase(worktreePath: string): Promise<void>
  getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult>
  getCommitCompare(worktreePath: string, commitId: string): Promise<GitCommitCompareResult>
  getUpstreamStatus(worktreePath: string, pushTarget?: GitPushTarget): Promise<GitUpstreamStatus>
  pushBranch(
    worktreePath: string,
    publish?: boolean,
    pushTarget?: GitPushTarget,
    options?: { forceWithLease?: boolean }
  ): Promise<void>
  pullBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  rebaseFromBase(worktreePath: string, baseRef: string): Promise<void>
  fetchRemote(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
  ): Promise<GitDiffResult[]>
  getCommitDiff(
    worktreePath: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string }
  ): Promise<GitDiffResult>
  listWorktrees(repoPath: string, options?: { signal?: AbortSignal }): Promise<GitWorktreeInfo[]>
  addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; checkoutExistingBranch?: boolean; noCheckout?: boolean }
  ): Promise<void>
  removeWorktree(
    worktreePath: string,
    force?: boolean,
    options?: { deleteBranch?: boolean; forceBranchDelete?: boolean }
  ): Promise<void>
  renameCurrentBranch?(worktreePath: string, newBranch: string): Promise<void>
  isGitRepo(path: string): boolean
  isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }>
  exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
  getRemoteFileUrl(worktreePath: string, relativePath: string, line: number): Promise<string | null>
  worktreeIsClean(worktreePath: string): Promise<{ clean: boolean; stdout?: string }>
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
