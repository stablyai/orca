/* eslint-disable max-lines -- Why: the preload contract is intentionally centralized in one declaration file so renderer and preload stay in lockstep when IPC surfaces change. */
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileScope,
  BrowserSessionProfileSource,
  CodexRateLimitAccountsState,
  CreateWorktreeResult,
  DirEntry,
  FsChangedPayload,
  GlobalSettings,
  GitBranchCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitStatusEntry,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubViewer,
  IssueInfo,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  OpenCodeStatusEvent,
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
import type {
  BrowserContextMenuDismissedEvent,
  BrowserContextMenuRequestedEvent,
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../shared/browser-guest-events'
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
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
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
  registerGuest: (args: {
    browserPageId: string
    workspaceId: string
    webContentsId: number
  }) => Promise<void>
  unregisterGuest: (args: { browserPageId: string }) => Promise<void>
  openDevTools: (args: { browserPageId: string }) => Promise<boolean>
  onGuestLoadFailed: (
    callback: (args: { browserPageId: string; loadError: BrowserLoadError }) => void
  ) => () => void
  onPermissionDenied: (callback: (event: BrowserPermissionDeniedEvent) => void) => () => void
  onPopup: (callback: (event: BrowserPopupEvent) => void) => () => void
  onDownloadRequested: (callback: (event: BrowserDownloadRequestedEvent) => void) => () => void
  onDownloadProgress: (callback: (event: BrowserDownloadProgressEvent) => void) => () => void
  onDownloadFinished: (callback: (event: BrowserDownloadFinishedEvent) => void) => () => void
  onContextMenuRequested: (
    callback: (event: BrowserContextMenuRequestedEvent) => void
  ) => () => void
  onContextMenuDismissed: (
    callback: (event: BrowserContextMenuDismissedEvent) => void
  ) => () => void
  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string }) => void
  ) => () => void
  acceptDownload: (args: {
    downloadId: string
  }) => Promise<{ ok: true } | { ok: false; reason: string }>
  cancelDownload: (args: { downloadId: string }) => Promise<boolean>
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  onGrabModeToggle: (callback: (browserPageId: string) => void) => () => void
  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ) => () => void
  sessionListProfiles: () => Promise<BrowserSessionProfile[]>
  sessionCreateProfile: (args: {
    scope: BrowserSessionProfileScope
    label: string
  }) => Promise<BrowserSessionProfile | null>
  sessionDeleteProfile: (args: { profileId: string }) => Promise<boolean>
  sessionImportCookies: (args: { profileId: string }) => Promise<BrowserCookieImportResult>
  sessionResolvePartition: (args: { profileId: string | null }) => Promise<string | null>
  sessionDetectBrowsers: () => Promise<DetectedBrowserInfo[]>
  sessionImportFromBrowser: (args: {
    profileId: string
    browserFamily: string
    browserProfile?: string
  }) => Promise<BrowserCookieImportResult>
  sessionClearDefaultCookies: () => Promise<boolean>
}

export type DetectedBrowserProfileInfo = {
  name: string
  directory: string
}

export type DetectedBrowserInfo = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  profiles: DetectedBrowserProfileInfo[]
  selectedProfile: string
}

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

export type PreflightApi = {
  check: (args?: { force?: boolean }) => Promise<PreflightStatus>
  detectAgents: () => Promise<string[]>
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

export type AppRuntimeFlags = {
  daemonEnabledAtStartup: boolean
}

export type DaemonTransitionNotice = {
  killedCount: number
}

export type AppApi = {
  /** Returns flags about the main-process state that was set at startup
   *  (e.g. whether the persistent terminal daemon actually started). The
   *  renderer uses this to show a "restart required" banner when the user
   *  toggles a setting that only applies across a full relaunch. */
  getRuntimeFlags: () => Promise<AppRuntimeFlags>
  /** Reads and clears any pending one-shot notice about a daemon cleanup
   *  that ran during startup (e.g. when upgrading from v1.3.0 where the
   *  daemon was on by default to a build where it's opt-in). Returns null
   *  when there is nothing to show. */
  consumeDaemonTransitionNotice: () => Promise<DaemonTransitionNotice | null>
  /** Relaunches the app via Electron's app.relaunch() + app.exit(0). Used
   *  by the "Restart now" button on the Experimental settings pane. */
  relaunch: () => Promise<void>
}

export type PreloadApi = {
  app: AppApi
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
    addRemote: (args: {
      connectionId: string
      remotePath: string
      displayName?: string
      kind?: 'git' | 'folder'
    }) => Promise<Repo>
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
      command?: string
      connectionId?: string | null
      worktreeId?: string
      sessionId?: string
    }) => Promise<{
      id: string
      snapshot?: string
      snapshotCols?: number
      snapshotRows?: number
      isReattach?: boolean
      isAlternateScreen?: boolean
      coldRestore?: { scrollback: string; cwd: string }
    }>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    signal: (id: string, signal: string) => void
    kill: (id: string) => Promise<void>
    ackColdRestore: (id: string) => void
    hasChildProcesses: (id: string) => Promise<boolean>
    getForegroundProcess: (id: string) => Promise<string | null>
    listSessions: () => Promise<{ id: string; cwd: string; title: string }[]>
    onData: (callback: (data: { id: string; data: string }) => void) => () => void
    onExit: (callback: (data: { id: string; code: number }) => void) => () => void
    onOpenCodeStatus: (callback: (event: OpenCodeStatusEvent) => void) => () => void
  }
  gh: {
    viewer: () => Promise<GitHubViewer | null>
    repoSlug: (args: { repoPath: string }) => Promise<{ owner: string; repo: string } | null>
    prForBranch: (args: { repoPath: string; branch: string }) => Promise<PRInfo | null>
    issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
    workItem: (args: { repoPath: string; number: number }) => Promise<GitHubWorkItem | null>
    workItemDetails: (args: {
      repoPath: string
      number: number
    }) => Promise<GitHubWorkItemDetails | null>
    prFileContents: (args: {
      repoPath: string
      prNumber: number
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }) => Promise<GitHubPRFileContents>
    listIssues: (args: { repoPath: string; limit?: number }) => Promise<IssueInfo[]>
    listWorkItems: (args: {
      repoPath: string
      limit?: number
      query?: string
    }) => Promise<GitHubWorkItem[]>
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
    pickAttachment: () => Promise<string | null>
    pickImage: () => Promise<string | null>
    pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
    copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
  }
  browser: BrowserApi
  hooks: {
    check: (args: {
      repoId: string
    }) => Promise<{ hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
    createIssueCommandRunner: (args: {
      repoId: string
      worktreePath: string
      command: string
    }) => Promise<WorktreeSetupLaunch>
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
    dismissNudge: () => Promise<void>
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
    onClearDismissal: (callback: () => void) => () => void
  }
  stats: StatsApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  fs: {
    readDir: (args: { dirPath: string; connectionId?: string }) => Promise<DirEntry[]>
    readFile: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }>
    writeFile: (args: { filePath: string; content: string; connectionId?: string }) => Promise<void>
    createFile: (args: { filePath: string; connectionId?: string }) => Promise<void>
    createDir: (args: { dirPath: string; connectionId?: string }) => Promise<void>
    rename: (args: { oldPath: string; newPath: string; connectionId?: string }) => Promise<void>
    deletePath: (args: { targetPath: string; connectionId?: string }) => Promise<void>
    authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
    stat: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
    listFiles: (args: { rootPath: string; connectionId?: string }) => Promise<string[]>
    search: (args: SearchOptions & { connectionId?: string }) => Promise<SearchResult>
    importExternalPaths: (args: { sourcePaths: string[]; destDir: string }) => Promise<{
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
    watchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    unwatchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    onFsChanged: (callback: (payload: FsChangedPayload) => void) => () => void
  }
  git: {
    status: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<{ entries: GitStatusEntry[] }>
    conflictOperation: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<GitConflictOperation>
    diff: (args: {
      worktreePath: string
      filePath: string
      staged: boolean
      connectionId?: string
    }) => Promise<GitDiffResult>
    branchCompare: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
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
      connectionId?: string
    }) => Promise<GitDiffResult>
    stage: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }) => Promise<void>
    bulkStage: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }) => Promise<void>
    unstage: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }) => Promise<void>
    bulkUnstage: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }) => Promise<void>
    discard: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }) => Promise<void>
    remoteFileUrl: (args: {
      worktreePath: string
      relativePath: string
      line: number
      connectionId?: string
    }) => Promise<string | null>
  }
  ui: {
    get: () => Promise<PersistedUIState>
    set: (args: Partial<PersistedUIState>) => Promise<void>
    onOpenSettings: (callback: () => void) => () => void
    onToggleLeftSidebar: (callback: () => void) => () => void
    onToggleRightSidebar: (callback: () => void) => () => void
    onToggleWorktreePalette: (callback: () => void) => () => void
    onOpenQuickOpen: (callback: () => void) => () => void
    onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
    onNewBrowserTab: (callback: () => void) => () => void
    onNewTerminalTab: (callback: () => void) => () => void
    onFocusBrowserAddressBar: (callback: () => void) => () => void
    onFindInBrowserPage: (callback: () => void) => () => void
    onReloadBrowserPage: (callback: () => void) => () => void
    onHardReloadBrowserPage: (callback: () => void) => () => void
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
      callback: (
        data:
          | { paths: string[]; target: 'editor' }
          | { paths: string[]; target: 'terminal' }
          | { paths: string[]; target: 'composer' }
          | { paths: string[]; target: 'file-explorer'; destinationDir: string }
      ) => void
    ) => () => void
    getZoomLevel: () => number
    setZoomLevel: (level: number) => void
    syncTrafficLights: (zoomFactor: number) => void
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
    onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
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
  ssh: {
    listTargets: () => Promise<SshTarget[]>
    addTarget: (args: { target: Omit<SshTarget, 'id'> }) => Promise<SshTarget>
    updateTarget: (args: {
      id: string
      updates: Partial<Omit<SshTarget, 'id'>>
    }) => Promise<SshTarget>
    removeTarget: (args: { id: string }) => Promise<void>
    importConfig: () => Promise<SshTarget[]>
    connect: (args: { targetId: string }) => Promise<SshConnectionState | null>
    disconnect: (args: { targetId: string }) => Promise<void>
    getState: (args: { targetId: string }) => Promise<SshConnectionState | null>
    testConnection: (args: {
      targetId: string
    }) => Promise<{ success: boolean; error?: string; state?: SshConnectionState }>
    onStateChanged: (
      callback: (data: { targetId: string; state: SshConnectionState }) => void
    ) => () => void
    addPortForward: (args: {
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }) => Promise<unknown>
    removePortForward: (args: { id: string }) => Promise<boolean>
    listPortForwards: (args?: { targetId?: string }) => Promise<unknown[]>
    browseDir: (args: { targetId: string; dirPath: string }) => Promise<{
      entries: { name: string; isDirectory: boolean }[]
      resolvedPath: string
    }>
    onCredentialRequest: (
      callback: (data: {
        requestId: string
        targetId: string
        kind: 'passphrase' | 'password'
        detail: string
      }) => void
    ) => () => void
    onCredentialResolved: (callback: (data: { requestId: string }) => void) => () => void
    submitCredential: (args: { requestId: string; value: string | null }) => Promise<void>
  }
}
