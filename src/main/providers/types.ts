import type {
  DirEntry,
  FsChangeEvent,
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitForkSyncExpectedUpstream,
  GitForkSyncResult,
  GitPushTarget,
  GitStagingArea,
  GitUpstreamStatus,
  GitWorktreeInfo,
  TuiAgent,
  RemoveWorktreeResult,
  SearchOptions,
  SearchResult
} from '../../shared/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { WorkspaceSpaceDirectoryScanResult } from '../../shared/workspace-space-types'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { GitProviderStatusOptions } from './git-provider-status-options'
import type { PtyBackgroundStreamEvent, PtyDataEvent } from './pty-provider-events'
import type { PtySpawnResult } from './pty-spawn-result'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'

export type {
  PtyBackgroundStreamEvent,
  PtyDataEvent,
  PtyTransientFact
} from './pty-provider-events'

// ─── PTY Provider ───────────────────────────────────────────────────

export type PtyProviderBufferSnapshot = {
  data: string
  /** Authoritative normal buffer captured beside an alternate-screen frame. */
  scrollbackAnsi?: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq: number
  source: 'headless'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  pendingEscapeTailAnsi?: string
}

export type PtySpawnOptions = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  /** Main-validated home provenance for an automatic Codex session resume. */
  codexHomePathOverride?: { value: string | null }
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  startupCommandDelivery?: StartupCommandDelivery
  /** Minimal allowlisted launch ownership preserved by daemon reattach. */
  launchAgent?: TuiAgent
  /** Orca worktree identity. When present, the local provider scopes shell
   *  history to this worktree so ArrowUp only surfaces local commands. */
  worktreeId?: string
  /** Stable terminal pane identity. Remote providers use this as PTY metadata
   *  even when it must not be exported into the spawned shell environment. */
  paneKey?: string
  /** Stable terminal tab identity used as a coarser attach guard when a pane
   *  identity is unavailable. */
  tabId?: string
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
  /** Fresh-spawn-only source authority installed before any PTY output is released. */
  startupIngress?: PtyStartupIngressIntent
  agentSessionEnsure?: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
  }
  /** Host-scoped structured-create identity used only for lower-owner replay. */
  agentSessionCreateOperationId?: string
  /** Signals that the native process exists even if later publication fails. */
  onPtySpawnCommitted?: () => void
  /** Cancels only before physical dispatch; operation identity fences later ambiguity. */
  signal?: AbortSignal
}

export type { PtySpawnResult }

export type PtyProcessInfo = {
  id: string
  incarnationId?: PtyIncarnationId
  cwd: string
  title: string
  /** Owning worktree when the provider can report it authoritatively. */
  worktreeId?: string
  /** Trusted ORCA_TERMINAL_HANDLE exported into this PTY, when known. */
  terminalHandle?: string
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

type PtyProbeOptions = { signal?: AbortSignal }

export type IPtyProvider = {
  spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>
  /** Whether this spawn target can append the Git guard after its final env merge. */
  supportsGitCredentialGuardHost?: (sessionId?: string) => boolean
  /** Explicit false selects pre-claim legacy spawn for a preserved old daemon. */
  supportsAgentSessionClaims?: (options?: PtyProbeOptions) => boolean | Promise<boolean>
  /** Whether missing claim metadata in this PTY's process listing proves absence. */
  providesAgentSessionOwnerListings?: (ptyId: string) => boolean
  /** Whether fresh structured creates can replay one spawn across a lost relay response. */
  supportsAgentSessionCreateOperations?: (options?: PtyProbeOptions) => boolean | Promise<boolean>
  attach(id: string): Promise<void>
  hasPty?: (id: string) => boolean
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /**
   * Producer-side flow control: stop/restart reading the underlying PTY so a
   * flooding child blocks on write (kernel backpressure) instead of growing
   * main-process buffers. Best-effort and optional — providers that cannot
   * pause (SSH relay, legacy daemon protocols) omit these or no-op silently,
   * and callers must keep functioning without them (the pending-output cap
   * still bounds memory when pause is unavailable).
   */
  pauseProducer?: (id: string) => void
  resumeProducer?: (id: string) => void
  /**
   * Hidden-delivery hint: the renderer has no visible view for this PTY, so
   * the provider's transport may keep-tail thin this PTY's monitoring stream
   * under backlog (bytes nobody is watching must not bury a visible pane's
   * echo). Best-effort and optional, like pauseProducer.
   */
  setPtyBackgrounded?: (id: string, background: boolean) => void
  /**
   * Facts a thinning transport interleaves with onData, in byte order:
   * scan-authority handoff markers, keep-tail gaps, and the transient facts
   * (bell/command-finished/pr-link/2031) it detected in bytes it was allowed
   * to drop. Only transports that thin implement it.
   */
  onBackgroundStreamEvent?: (callback: (payload: PtyBackgroundStreamEvent) => void) => () => void
  /** Authoritative provider-owned model snapshot. Daemon providers expose this
   * after their monitoring stream gaps; other providers may omit it. */
  getBufferSnapshot?: (
    id: string,
    opts?: { scrollbackRows?: number }
  ) => Promise<PtyProviderBufferSnapshot | null>
  /** Whether this exact PTY can return a sequence-safe provider snapshot. */
  canProvideAuthoritativeBufferSnapshot?: (id: string) => boolean
  /**
   * The size the PTY has ACTUALLY applied, not the last size requested.
   * resize() is fire-and-forget for remote providers (daemon/SSH `notify`),
   * so a resize can be silently dropped (session not yet alive, dead handle,
   * cold-restore snapshot-cols coercion) while the caller still believes it
   * landed. This is the readback the renderer's resume drift-check compares
   * against to detect — and re-assert past — such drops. Returns null when the
   * provider cannot confirm the applied size (unknown id, relay unreachable);
   * callers treat null as "cannot confirm" and re-forward once. Optional so
   * providers without an authoritative size source can omit it.
   */
  getAppliedSize?: (id: string) => Promise<{ cols: number; rows: number } | null>

  // Why: deadlineMs (absolute epoch ms) bounds the underlying RPCs so destructive
  // teardown fails fast inside its sweep budget instead of tripping the outer sweep
  // deadline; each RPC leaf converts to a relative timeout when it actually issues.
  shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void>
  sendSignal(id: string, signal: string): Promise<void>
  getCwd(id: string): Promise<string>
  getInitialCwd(id: string): Promise<string>
  clearBuffer(id: string): Promise<void>
  /** Ordered handoff from startup source authority to the live/hidden view authority. */
  closeStartupQueryAuthority?: (id: string) => Promise<number> | number
  acknowledgeDataEvent(id: string, charCount: number): void
  hasChildProcesses(id: string): Promise<boolean>
  getForegroundProcess(id: string): Promise<string | null>
  /** Strong process evidence captured after the caller's command boundary. */
  confirmForegroundProcess?: (id: string) => Promise<string | null>
  serialize(ids: string[]): Promise<string>
  revive(state: string): Promise<void>
  // Why: deadlineMs bounds the underlying RPC exactly like shutdown's deadlineMs.
  listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]>
  getDefaultShell(): Promise<string>
  getProfiles(): Promise<{ name: string; path: string }[]>
  onData(callback: (payload: PtyDataEvent) => void): () => void
  onReplay(callback: (payload: { id: string; data: string }) => void): () => void
  onExit(
    callback: (payload: { id: string; code: number; incarnationId?: PtyIncarnationId }) => void
  ): () => void
}

// ─── Filesystem Provider ────────────────────────────────────────────

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

export type IFilesystemProvider = {
  readDir(dirPath: string): Promise<DirEntry[]>
  readFile(filePath: string): Promise<FileReadResult>
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
    options?: { excludePaths?: string[]; signal?: AbortSignal; maxResults?: number }
  ): Promise<string[]>
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

// ─── Git Provider ───────────────────────────────────────────────────

export type { GitProviderStatusOptions } from './git-provider-status-options'

export type IGitProvider = {
  getStatus(worktreePath: string, options?: GitProviderStatusOptions): Promise<GitStatusResult>
  getSubmoduleStatus(
    worktreePath: string,
    submodulePath: string,
    area?: GitStagingArea
  ): Promise<GitStatusResult>
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
  checkoutBranch(worktreePath: string, branch: string): Promise<void>
  listLocalBranches(worktreePath: string): Promise<{ current: string | null; branches: string[] }>
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
  fastForwardBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  rebaseFromBase(worktreePath: string, baseRef: string): Promise<void>
  fetchRemote(worktreePath: string, pushTarget?: GitPushTarget): Promise<void>
  syncForkDefaultBranch(
    worktreePath: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitForkSyncResult>
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
  ): Promise<RemoveWorktreeResult>
  renameCurrentBranch?(worktreePath: string, newBranch: string): Promise<void>
  forceDeletePreservedBranch?(
    repoPath: string,
    branchName: string,
    expectedHead: string
  ): Promise<void>
  isGitRepo(path: string): boolean
  isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }>
  exec(
    args: string[],
    cwd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string }>
  getRemoteFileUrl(worktreePath: string, relativePath: string, line: number): Promise<string | null>
  getRemoteCommitUrl(worktreePath: string, sha: string): Promise<string | null>
  worktreeIsClean(
    worktreePath: string,
    options?: { includeUntracked?: boolean }
  ): Promise<{ clean: boolean; stdout?: string }>
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
