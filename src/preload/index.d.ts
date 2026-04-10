import type { ElectronAPI } from '@electron-toolkit/preload'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import type {
  Repo,
  Worktree,
  WorktreeMeta,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  PRInfo,
  PRCheckDetail,
  PRComment,
  IssueInfo,
  GlobalSettings,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  OrcaHooks,
  PersistedUIState,
  WorkspaceSessionState,
  WorktreeSetupLaunch,
  UpdateStatus,
  DirEntry,
  GitBranchCompareResult,
  GitConflictOperation,
  GitStatusEntry,
  GitDiffResult,
  SearchOptions,
  SearchResult,
  StatsSummary
} from '../../shared/types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRange,
  ClaudeUsageScanState,
  ClaudeUsageScope,
  ClaudeUsageSessionRow,
  ClaudeUsageSummary
} from '../../shared/claude-usage-types'

type ReposApi = {
  list: () => Promise<Repo[]>
  add: (args: { path: string; kind?: 'git' | 'folder' }) => Promise<Repo>
  remove: (args: { repoId: string }) => Promise<void>
  update: (args: {
    repoId: string
    updates: Partial<
      Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>
    >
  }) => Promise<Repo>
  pickFolder: () => Promise<string | null>
  pickDirectory: () => Promise<string | null>
  clone: (args: { url: string; destination: string }) => Promise<Repo>
  cloneAbort: () => Promise<void>
  onCloneProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void
  getGitUsername: (args: { repoId: string }) => Promise<string>
  getBaseRefDefault: (args: { repoId: string }) => Promise<string>
  searchBaseRefs: (args: { repoId: string; query: string; limit?: number }) => Promise<string[]>
  onChanged: (callback: () => void) => () => void
}

type WorktreesApi = {
  list: (args: { repoId: string }) => Promise<Worktree[]>
  listAll: () => Promise<Worktree[]>
  create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
  remove: (args: { worktreeId: string; force?: boolean }) => Promise<void>
  updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
  persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
}

type PtyApi = {
  spawn: (opts: {
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
  }) => Promise<{ id: string }>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => Promise<void>
  hasChildProcesses: (id: string) => Promise<boolean>
  onData: (callback: (data: { id: string; data: string }) => void) => () => void
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void
}

type GhApi = {
  prForBranch: (args: { repoPath: string; branch: string }) => Promise<PRInfo | null>
  issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
  listIssues: (args: { repoPath: string; limit?: number }) => Promise<IssueInfo[]>
  prChecks: (args: {
    repoPath: string
    prNumber: number
    headSha?: string
    noCache?: boolean
  }) => Promise<PRCheckDetail[]>
  prComments: (args: {
    repoPath: string
    prNumber: number
    noCache?: boolean
  }) => Promise<PRComment[]>
  resolveReviewThread: (args: {
    repoPath: string
    threadId: string
    resolve: boolean
  }) => Promise<boolean>
  updatePRTitle: (args: { repoPath: string; prNumber: number; title: string }) => Promise<boolean>
  mergePR: (args: {
    repoPath: string
    prNumber: number
    method?: 'merge' | 'squash' | 'rebase'
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  checkOrcaStarred: () => Promise<boolean | null>
  starOrca: () => Promise<boolean>
}

type SettingsApi = {
  get: () => Promise<GlobalSettings>
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
}

type CliApi = {
  getInstallStatus: () => Promise<CliInstallStatus>
  install: () => Promise<CliInstallStatus>
  remove: () => Promise<CliInstallStatus>
}

type NotificationsApi = {
  dispatch: (args: NotificationDispatchRequest) => Promise<NotificationDispatchResult>
  openSystemSettings: () => Promise<void>
}

type ShellApi = {
  openPath: (path: string) => Promise<void>
  openUrl: (url: string) => Promise<void>
  openFilePath: (path: string) => Promise<void>
  openFileUri: (uri: string) => Promise<void>
  pathExists: (path: string) => Promise<boolean>
  pickImage: () => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
}

type HooksApi = {
  check: (args: { repoId: string }) => Promise<{ hasHooks: boolean; hooks: OrcaHooks | null }>
}

type CacheApi = {
  getGitHub: () => Promise<{
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }>
  setGitHub: (args: {
    cache: {
      pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
      issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
    }
  }) => Promise<void>
}

type SessionApi = {
  get: () => Promise<WorkspaceSessionState>
  set: (args: WorkspaceSessionState) => Promise<void>
  /** Synchronous session save for beforeunload — blocks until flushed to disk. */
  setSync: (args: WorkspaceSessionState) => void
}

type UpdaterApi = {
  getVersion: () => Promise<string>
  getStatus: () => Promise<UpdateStatus>
  check: () => Promise<void>
  download: () => Promise<void>
  quitAndInstall: () => Promise<void>
  onStatus: (callback: (status: UpdateStatus) => void) => () => void
}

type UIApi = {
  get: () => Promise<PersistedUIState>
  set: (args: Partial<PersistedUIState>) => Promise<void>
  onOpenSettings: (callback: () => void) => () => void
  onActivateWorktree: (
    callback: (data: { repoId: string; worktreeId: string; setup?: WorktreeSetupLaunch }) => void
  ) => () => void
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  readClipboardText: () => Promise<string>
  writeClipboardText: (text: string) => Promise<void>
  onFileDrop: (
    callback: (data: { path: string; target: 'editor' | 'terminal' }) => void
  ) => () => void
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
  onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
  onWindowCloseRequested: (callback: () => void) => () => void
  confirmWindowClose: () => void
}

type RuntimeApi = {
  syncWindowGraph: (graph: RuntimeSyncWindowGraph) => Promise<RuntimeStatus>
  getStatus: () => Promise<RuntimeStatus>
}

type FsApi = {
  readDir: (args: { dirPath: string }) => Promise<DirEntry[]>
  readFile: (args: {
    filePath: string
  }) => Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }>
  writeFile: (args: { filePath: string; content: string }) => Promise<void>
  createFile: (args: { filePath: string }) => Promise<void>
  createDir: (args: { dirPath: string }) => Promise<void>
  rename: (args: { oldPath: string; newPath: string }) => Promise<void>
  deletePath: (args: { targetPath: string }) => Promise<void>
  authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
  stat: (args: {
    filePath: string
  }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
  listFiles: (args: { rootPath: string }) => Promise<string[]>
  search: (args: SearchOptions) => Promise<SearchResult>
}

type GitApi = {
  status: (args: { worktreePath: string }) => Promise<GitStatusResult>
  conflictOperation: (args: { worktreePath: string }) => Promise<GitConflictOperation>
  diff: (args: {
    worktreePath: string
    filePath: string
    staged: boolean
  }) => Promise<GitDiffResult>
  branchCompare: (args: {
    worktreePath: string
    baseRef: string
  }) => Promise<GitBranchCompareResult>
  branchDiff: (args: {
    worktreePath: string
    compare: {
      baseRef: string
      baseOid: string
      headOid: string
      mergeBase: string
    }
    filePath: string
    oldPath?: string
  }) => Promise<GitDiffResult>
  stage: (args: { worktreePath: string; filePath: string }) => Promise<void>
  bulkStage: (args: { worktreePath: string; filePaths: string[] }) => Promise<void>
  unstage: (args: { worktreePath: string; filePath: string }) => Promise<void>
  bulkUnstage: (args: { worktreePath: string; filePaths: string[] }) => Promise<void>
  discard: (args: { worktreePath: string; filePath: string }) => Promise<void>
  remoteFileUrl: (args: {
    worktreePath: string
    relativePath: string
    line: number
  }) => Promise<string | null>
}

type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

type PreflightApi = {
  check: () => Promise<PreflightStatus>
}

type StatsApi = {
  getSummary: () => Promise<StatsSummary>
}

type ClaudeUsageApi = {
  getScanState: () => Promise<ClaudeUsageScanState>
  setEnabled: (args: { enabled: boolean }) => Promise<ClaudeUsageScanState>
  refresh: (args?: { force?: boolean }) => Promise<ClaudeUsageScanState>
  getSummary: (args: {
    scope: ClaudeUsageScope
    range: ClaudeUsageRange
  }) => Promise<ClaudeUsageSummary>
  getDaily: (args: {
    scope: ClaudeUsageScope
    range: ClaudeUsageRange
  }) => Promise<ClaudeUsageDailyPoint[]>
  getBreakdown: (args: {
    scope: ClaudeUsageScope
    range: ClaudeUsageRange
    kind: ClaudeUsageBreakdownKind
  }) => Promise<ClaudeUsageBreakdownRow[]>
  getRecentSessions: (args: {
    scope: ClaudeUsageScope
    range: ClaudeUsageRange
    limit?: number
  }) => Promise<ClaudeUsageSessionRow[]>
}

type Api = {
  repos: ReposApi
  worktrees: WorktreesApi
  pty: PtyApi
  gh: GhApi
  settings: SettingsApi
  cli: CliApi
  preflight: PreflightApi
  notifications: NotificationsApi
  shell: ShellApi
  hooks: HooksApi
  cache: CacheApi
  session: SessionApi
  updater: UpdaterApi
  stats: StatsApi
  claudeUsage: ClaudeUsageApi
  fs: FsApi
  git: GitApi
  ui: UIApi
  runtime: RuntimeApi
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
