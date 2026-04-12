/* eslint-disable max-lines -- Why: the preload contract is intentionally centralized in one declaration file so renderer and preload stay in lockstep when IPC surfaces change. */
import type {
  BrowserLoadError,
  CodexRateLimitAccountsState,
  CreateWorktreeResult,
  DirEntry,
  FsChangedPayload,
  GlobalSettings,
  GitBranchCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitStatusEntry,
  GitHubViewer,
  IssueInfo,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  OrcaHooks,
  PersistedUIState,
  PRCheckDetail,
  PRComment,
  PRInfo,
  Repo,
  SearchOptions,
  SearchResult,
  StatsSummary,
  UpdateStatus,
  Worktree,
  WorktreeMeta,
  WorktreeSetupLaunch,
  WorkspaceSessionState
} from '../../shared/types'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../../shared/browser-grab-types'
import type { CliInstallStatus } from '../../shared/cli-install-types'
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
import type { RateLimitState } from '../../shared/rate-limit-types'
import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageRange,
  CodexUsageScanState,
  CodexUsageScope,
  CodexUsageSessionRow,
  CodexUsageSummary
} from '../../shared/codex-usage-types'

export type BrowserApi = {
  registerGuest: (args: { browserTabId: string; webContentsId: number }) => Promise<void>
  unregisterGuest: (args: { browserTabId: string }) => Promise<void>
  openDevTools: (args: { browserTabId: string }) => Promise<boolean>
  onGuestLoadFailed: (
    callback: (args: { browserTabId: string; loadError: BrowserLoadError }) => void
  ) => () => void
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  onGrabModeToggle: (callback: (browserTabId: string) => void) => () => void
}

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

export type PreflightApi = {
  check: (args?: { force?: boolean }) => Promise<PreflightStatus>
}

export type StatsApi = {
  getSummary: () => Promise<StatsSummary>
}

export type ClaudeUsageApi = {
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

export type CodexUsageApi = {
  getScanState: () => Promise<CodexUsageScanState>
  setEnabled: (args: { enabled: boolean }) => Promise<CodexUsageScanState>
  refresh: (args?: { force?: boolean }) => Promise<CodexUsageScanState>
  getSummary: (args: {
    scope: CodexUsageScope
    range: CodexUsageRange
  }) => Promise<CodexUsageSummary>
  getDaily: (args: {
    scope: CodexUsageScope
    range: CodexUsageRange
  }) => Promise<CodexUsageDailyPoint[]>
  getBreakdown: (args: {
    scope: CodexUsageScope
    range: CodexUsageRange
    kind: CodexUsageBreakdownKind
  }) => Promise<CodexUsageBreakdownRow[]>
  getRecentSessions: (args: {
    scope: CodexUsageScope
    range: CodexUsageRange
    limit?: number
  }) => Promise<CodexUsageSessionRow[]>
}

export type PreloadApi = {
  repos: {
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
  worktrees: {
    list: (args: { repoId: string }) => Promise<Worktree[]>
    listAll: () => Promise<Worktree[]>
    create: (args: {
      repoId: string
      name: string
      baseBranch?: string
      setupDecision?: 'inherit' | 'run' | 'skip'
    }) => Promise<CreateWorktreeResult>
    remove: (args: { worktreeId: string; force?: boolean }) => Promise<void>
    updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
    persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
    onChanged: (callback: (data: { repoId: string }) => void) => () => void
  }
  pty: {
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
    getForegroundProcess: (id: string) => Promise<string | null>
    onData: (callback: (data: { id: string; data: string }) => void) => () => void
    onExit: (callback: (data: { id: string; code: number }) => void) => () => void
  }
  gh: {
    viewer: () => Promise<GitHubViewer | null>
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
  settings: {
    get: () => Promise<GlobalSettings>
    set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
    listFonts: () => Promise<string[]>
  }
  codexAccounts: {
    list: () => Promise<CodexRateLimitAccountsState>
    add: () => Promise<CodexRateLimitAccountsState>
    reauthenticate: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
    remove: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
    select: (args: { accountId: string | null }) => Promise<CodexRateLimitAccountsState>
  }
  cli: {
    getInstallStatus: () => Promise<CliInstallStatus>
    install: () => Promise<CliInstallStatus>
    remove: () => Promise<CliInstallStatus>
  }
  preflight: PreflightApi
  notifications: {
    dispatch: (args: NotificationDispatchRequest) => Promise<NotificationDispatchResult>
    openSystemSettings: () => Promise<void>
  }
  shell: {
    openPath: (path: string) => Promise<void>
    openUrl: (url: string) => Promise<void>
    openFilePath: (path: string) => Promise<void>
    openFileUri: (uri: string) => Promise<void>
    pathExists: (path: string) => Promise<boolean>
    pickImage: () => Promise<string | null>
    copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
  }
  browser: BrowserApi
  hooks: {
    check: (args: {
      repoId: string
    }) => Promise<{ hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
    readIssueCommand: (args: { repoId: string }) => Promise<{
      localContent: string | null
      sharedContent: string | null
      effectiveContent: string | null
      localFilePath: string
      source: 'local' | 'shared' | 'none'
    }>
    writeIssueCommand: (args: { repoId: string; content: string }) => Promise<void>
  }
  cache: {
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
  session: {
    get: () => Promise<WorkspaceSessionState>
    set: (args: WorkspaceSessionState) => Promise<void>
    setSync: (args: WorkspaceSessionState) => void
  }
  updater: {
    getVersion: () => Promise<string>
    getStatus: () => Promise<UpdateStatus>
    check: () => Promise<void>
    download: () => Promise<void>
    quitAndInstall: () => Promise<void>
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
  }
  stats: StatsApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  fs: {
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
    watchWorktree: (args: { worktreePath: string }) => Promise<void>
    unwatchWorktree: (args: { worktreePath: string }) => Promise<void>
    onFsChanged: (callback: (payload: FsChangedPayload) => void) => () => void
  }
  git: {
    status: (args: { worktreePath: string }) => Promise<{ entries: GitStatusEntry[] }>
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
  ui: {
    get: () => Promise<PersistedUIState>
    set: (args: Partial<PersistedUIState>) => Promise<void>
    onOpenSettings: (callback: () => void) => () => void
    onToggleWorktreePalette: (callback: () => void) => () => void
    onOpenQuickOpen: (callback: () => void) => () => void
    onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
    onNewBrowserTab: (callback: () => void) => () => void
    onNewTerminalTab: (callback: () => void) => () => void
    onCloseActiveTab: (callback: () => void) => () => void
    onSwitchTab: (callback: (direction: 1 | -1) => void) => () => void
    onToggleStatusBar: (callback: () => void) => () => void
    onActivateWorktree: (
      callback: (data: { repoId: string; worktreeId: string; setup?: WorktreeSetupLaunch }) => void
    ) => () => void
    onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
    readClipboardText: () => Promise<string>
    saveClipboardImageAsTempFile: () => Promise<string | null>
    writeClipboardText: (text: string) => Promise<void>
    writeClipboardImage: (dataUrl: string) => Promise<void>
    onFileDrop: (
      callback: (data: { path: string; target: 'editor' | 'terminal' }) => void
    ) => () => void
    getZoomLevel: () => number
    setZoomLevel: (level: number) => void
    syncTrafficLights: (zoomFactor: number) => void
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
    onWindowCloseRequested: (callback: () => void) => () => void
    confirmWindowClose: () => void
  }
  runtime: {
    syncWindowGraph: (graph: RuntimeSyncWindowGraph) => Promise<RuntimeStatus>
    getStatus: () => Promise<RuntimeStatus>
  }
  rateLimits: {
    get: () => Promise<RateLimitState>
    refresh: () => Promise<RateLimitState>
    setPollingInterval: (ms: number) => Promise<void>
    onUpdate: (callback: (state: RateLimitState) => void) => () => void
  }
}
