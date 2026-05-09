/* eslint-disable max-lines -- Why: the preload contract is intentionally centralized in one declaration file so renderer and preload stay in lockstep when IPC surfaces change. */
import type {
  BaseRefDefaultResult,
  BrowserCookieImportResult,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileScope,
  BrowserSessionProfileSource,
  BrowserViewportOverride,
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  CustomPet,
  DirEntry,
  FsChangedPayload,
  GhosttyImportPreview,
  GlobalSettings,
  GitBranchCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitStatusResult,
  GitUpstreamStatus,
  GitHubAssignableUser,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubPRReviewCommentInput,
  GitHubCommentResult,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubViewer,
  ListWorkItemsResult,
  IssueInfo,
  LinearViewer,
  LinearConnectionStatus,
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearWorkflowState,
  LinearLabel,
  LinearMember,
  LinearTeam,
  MarkdownDocument,
  GitHubIssueUpdate,
  GetRateLimitResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundResult,
  OnboardingState,
  OrcaHooks,
  PersistedUIState,
  PRCheckDetail,
  PRComment,
  PRInfo,
  Repo,
  SparsePreset,
  SearchOptions,
  SearchResult,
  StatsSummary,
  MemorySnapshot,
  UpdateStatus,
  Worktree,
  WorktreeBaseStatusEvent,
  WorktreeMeta,
  WorktreeRemoteBranchConflictEvent,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch,
  WorkspaceSessionState
} from '../shared/types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugArgs,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugArgs,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugArgs,
  ListLabelsBySlugResult,
  ListProjectViewsArgs,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugArgs,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefArgs,
  ResolveProjectRefResult,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../shared/github-project-types'
import type { RichMarkdownContextMenuCommandPayload } from '../shared/rich-markdown-context-menu'
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
} from '../shared/browser-grab-types'
import type {
  BrowserContextMenuDismissedEvent,
  BrowserContextMenuRequestedEvent,
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../shared/browser-guest-events'
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type { E2EConfig } from '../shared/e2e-config'
import type { AgentHookInstallStatus } from '../shared/agent-hook-types'
import type { AgentStatusState } from '../shared/agent-status-types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../shared/runtime-types'
import type {
  DeveloperPermissionId,
  DeveloperPermissionRequestResult,
  DeveloperPermissionState
} from '../shared/developer-permissions-types'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRange,
  ClaudeUsageScanState,
  ClaudeUsageScope,
  ClaudeUsageSessionRow,
  ClaudeUsageSummary
} from '../shared/claude-usage-types'
import type { RateLimitState } from '../shared/rate-limit-types'
import type { GhAuthDiagnostic } from '../shared/github-auth-types'
import type {
  SshConnectionState,
  SshTarget,
  PortForwardEntry,
  DetectedPort
} from '../shared/ssh-types'
import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageRange,
  CodexUsageScanState,
  CodexUsageScope,
  CodexUsageSessionRow,
  CodexUsageSummary
} from '../shared/codex-usage-types'
import type { TelemetryConsentState } from '../shared/telemetry-consent-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'

export type BrowserApi = {
  registerGuest: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }) => Promise<void>
  unregisterGuest: (args: { browserPageId: string }) => Promise<void>
  openDevTools: (args: { browserPageId: string }) => Promise<boolean>
  setViewportOverride: (args: {
    browserPageId: string
    override: BrowserViewportOverride | null
  }) => Promise<boolean>
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
  onNavigationUpdate: (
    callback: (event: { browserPageId: string; url: string; title: string }) => void
  ) => () => void
  onActivateView: (callback: (data: { worktreeId: string }) => void) => () => void
  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
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
  notifyActiveTabChanged: (args: { browserPageId: string }) => Promise<boolean>
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

export type RefreshAgentsResult = {
  agents: string[]
  addedPathSegments: string[]
  shellHydrationOk: boolean
}

export type PreflightApi = {
  check: (args?: { force?: boolean }) => Promise<PreflightStatus>
  detectAgents: () => Promise<string[]>
  refreshAgents: () => Promise<RefreshAgentsResult>
  detectRemoteAgents: (args: { connectionId: string }) => Promise<string[]>
}

// Why: renderer-facing mirror of the daemon's `SessionInfo` + protocolVersion
// annotation (src/main/daemon/types.ts `DaemonSessionInfo`). Kept here instead
// of imported from main because the preload boundary must not depend on
// main-only protocol types — those are subprocess-facing. Keep the two shapes
// in sync when adding fields on either side; the Manage Sessions panel reads
// these directly.
export type PtyManagementSession = {
  sessionId: string
  state: 'created' | 'spawning' | 'running' | 'exiting' | 'exited'
  shellState: 'pending' | 'ready' | 'timed_out' | 'unsupported'
  isAlive: boolean
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  protocolVersion: number
}

export type PtyManagementApi = {
  listSessions: () => Promise<{ sessions: PtyManagementSession[] }>
  killAll: () => Promise<{ killedCount: number; remainingCount: number }>
  killOne: (args: { sessionId: string }) => Promise<{ success: boolean }>
  restart: () => Promise<{ success: boolean }>
}

export type ExportApi = {
  htmlToPdf: (args: {
    html: string
    title: string
  }) => Promise<
    { success: true; filePath: string } | { success: false; cancelled?: boolean; error?: string }
  >
}

export type StatsApi = {
  getSummary: () => Promise<StatsSummary>
}

export type MemoryApi = {
  getSnapshot: () => Promise<MemorySnapshot>
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

export type AppApi = {
  /** Relaunches the app via Electron's app.relaunch() + app.exit(0). Used
   *  by settings panes that need a full restart to apply changes (e.g. the
   *  terminal-window blur setting in TerminalWindowSection). */
  relaunch: () => Promise<void>
  /** Returns the macOS `AppleCurrentKeyboardLayoutInputSourceID` when
   *  available (e.g. `com.apple.keylayout.PolishPro`). Used by the
   *  keyboard-layout probe to distinguish layouts whose base layer matches
   *  US QWERTY but whose Option layer composes characters (issue #1205).
   *  Returns null on non-Darwin platforms or when the defaults read fails. */
  getKeyboardInputSourceId: () => Promise<string | null>
}

export type PreloadApi = {
  app: AppApi
  e2e: {
    getConfig: () => E2EConfig
  }
  repos: {
    list: () => Promise<Repo[]>
    // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
    add: (args: {
      path: string
      kind?: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    remove: (args: { repoId: string }) => Promise<void>
    update: (args: {
      repoId: string
      updates: Partial<
        Pick<
          Repo,
          | 'displayName'
          | 'badgeColor'
          | 'hookSettings'
          | 'worktreeBaseRef'
          | 'kind'
          | 'issueSourcePreference'
        >
      >
    }) => Promise<Repo>
    pickFolder: () => Promise<string | null>
    pickDirectory: () => Promise<string | null>
    clone: (args: { url: string; destination: string }) => Promise<Repo>
    cloneAbort: () => Promise<void>
    // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
    addRemote: (args: {
      connectionId: string
      remotePath: string
      displayName?: string
      kind?: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
    create: (args: {
      parentPath: string
      name: string
      kind: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    onCloneProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void
    getGitUsername: (args: { repoId: string }) => Promise<string>
    getBaseRefDefault: (args: { repoId: string }) => Promise<BaseRefDefaultResult>
    searchBaseRefs: (args: { repoId: string; query: string; limit?: number }) => Promise<string[]>
    onChanged: (callback: () => void) => () => void
  }
  sparsePresets: {
    list: (args: { repoId: string }) => Promise<SparsePreset[]>
    save: (args: {
      repoId: string
      id?: string
      name: string
      directories: string[]
    }) => Promise<SparsePreset>
    remove: (args: { repoId: string; presetId: string }) => Promise<void>
    onChanged: (callback: (data: { repoId: string }) => void) => () => void
  }
  worktrees: {
    list: (args: { repoId: string }) => Promise<Worktree[]>
    listAll: () => Promise<Worktree[]>
    create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
    resolvePrBase: (args: {
      repoId: string
      prNumber: number
      headRefName?: string
      isCrossRepository?: boolean
    }) => Promise<{ baseBranch: string } | { error: string }>
    remove: (args: { worktreeId: string; force?: boolean; skipArchive?: boolean }) => Promise<void>
    updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
    persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
    onChanged: (callback: (data: { repoId: string }) => void) => () => void
    onBaseStatus: (callback: (data: WorktreeBaseStatusEvent) => void) => () => void
    onRemoteBranchConflict: (
      callback: (data: WorktreeRemoteBranchConflictEvent) => void
    ) => () => void
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
      // Why: lets a single tab open in a different shell than the user's default.
      // Preserved from the deleted index.d.ts PtyApi duplicate during the
      // single-source-of-truth collapse (see docs/preload-typecheck-hole.md §1).
      shellOverride?: string
      // Why: closes the SIGKILL race documented in INVESTIGATION.md — main
      // sync-flushes the (worktreeId, tabId, leafId → ptyId) binding before
      // pty:spawn returns. Only the renderer's daemon-host path threads these.
      tabId?: string
      leafId?: string
      // Why: telemetry-plan.md§Agent launch semantics — main emits
      // `agent_started` only after the PTY/session is created successfully,
      // so the renderer threads the launch metadata through this field and
      // the IPC handler fires the event from the spawn-success branch.
      telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
    }) => Promise<{
      id: string
      snapshot?: string
      snapshotCols?: number
      snapshotRows?: number
      isReattach?: boolean
      isAlternateScreen?: boolean
      replay?: string
      sessionExpired?: boolean
      coldRestore?: { scrollback: string; cwd: string }
    }>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    reportGeometry: (id: string, cols: number, rows: number) => void
    signal: (id: string, signal: string) => void
    kill: (id: string, opts?: { keepHistory?: boolean }) => Promise<void>
    ackColdRestore: (id: string) => void
    hasChildProcesses: (id: string) => Promise<boolean>
    getForegroundProcess: (id: string) => Promise<string | null>
    getCwd: (id: string) => Promise<string>
    listSessions: () => Promise<{ id: string; cwd: string; title: string }[]>
    onData: (callback: (data: { id: string; data: string }) => void) => () => void
    onReplay: (callback: (data: { id: string; data: string }) => void) => () => void
    onExit: (callback: (data: { id: string; code: number }) => void) => () => void
    onSerializeBufferRequest: (
      callback: (data: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      }) => void
    ) => () => void
    sendSerializedBuffer: (
      requestId: string,
      snapshot: { data: string; cols: number; rows: number; lastTitle?: string } | null
    ) => void
    declarePendingPaneSerializer: (paneKey: string) => Promise<number>
    settlePaneSerializer: (paneKey: string, gen: number) => Promise<void>
    clearPendingPaneSerializer: (paneKey: string, gen: number) => Promise<void>
    management: PtyManagementApi
  }
  feedback: {
    submit: (args: {
      feedback: string
      submitAnonymously?: boolean
      githubLogin: string | null
      githubEmail: string | null
    }) => Promise<{ ok: true } | { ok: false; status: number | null; error: string }>
  }
  export: ExportApi
  gh: {
    viewer: () => Promise<GitHubViewer | null>
    repoSlug: (args: { repoPath: string }) => Promise<{ owner: string; repo: string } | null>
    prForBranch: (args: {
      repoPath: string
      branch: string
      linkedPRNumber?: number | null
    }) => Promise<PRInfo | null>
    issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
    workItem: (args: {
      repoPath: string
      number: number
      type?: 'issue' | 'pr'
    }) => Promise<Omit<GitHubWorkItem, 'repoId'> | null>
    workItemByOwnerRepo: (args: {
      repoPath: string
      owner: string
      repo: string
      number: number
      type: 'issue' | 'pr'
    }) => Promise<Omit<GitHubWorkItem, 'repoId'> | null>
    workItemDetails: (args: {
      repoPath: string
      number: number
      type?: 'issue' | 'pr'
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
    createIssue: (args: {
      repoPath: string
      title: string
      body: string
    }) => Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>
    countWorkItems: (args: { repoPath: string; query?: string }) => Promise<number>
    listWorkItems: (args: {
      repoPath: string
      limit?: number
      query?: string
      before?: string
    }) => Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>>
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
    updateIssue: (args: {
      repoPath: string
      number: number
      updates: GitHubIssueUpdate
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    addIssueComment: (args: {
      repoPath: string
      number: number
      body: string
    }) => Promise<GitHubCommentResult>
    addPRReviewCommentReply: (args: {
      repoPath: string
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
    }) => Promise<GitHubCommentResult>
    addPRReviewComment: (args: GitHubPRReviewCommentInput) => Promise<GitHubCommentResult>
    listLabels: (args: { repoPath: string }) => Promise<string[]>
    listAssignableUsers: (args: { repoPath: string }) => Promise<GitHubAssignableUser[]>
    checkOrcaStarred: () => Promise<boolean | null>
    starOrca: () => Promise<boolean>
    /**
     * GitHub API rate-limit snapshot. Does NOT consume quota (the
     * `rate_limit` endpoint is exempt). Cached 30s server-side — pass
     * `force: true` to bust after a known-expensive op.
     */
    rateLimit: (args?: { force?: boolean }) => Promise<GetRateLimitResult>
    /**
     * Probe `gh auth status` and the Electron process env to explain
     * why ProjectV2 calls are failing with scope_missing. Surfaces the
     * common gotcha where `GITHUB_TOKEN` is exported in the user's
     * shell and silently shadows the keyring credential — in that case
     * `gh auth refresh` is a no-op and the UI must say so.
     */
    diagnoseAuth: () => Promise<GhAuthDiagnostic>
    // ── ProjectV2 (GitHub Projects) ─────────────────────────────────
    listAccessibleProjects: () => Promise<ListAccessibleProjectsResult>
    resolveProjectRef: (args: ResolveProjectRefArgs) => Promise<ResolveProjectRefResult>
    listProjectViews: (args: ListProjectViewsArgs) => Promise<ListProjectViewsResult>
    getProjectViewTable: (args: GetProjectViewTableArgs) => Promise<GetProjectViewTableResult>
    projectWorkItemDetailsBySlug: (
      args: ProjectWorkItemDetailsBySlugArgs
    ) => Promise<ProjectWorkItemDetailsBySlugResult>
    updateProjectItemField: (
      args: UpdateProjectItemFieldArgs
    ) => Promise<GitHubProjectMutationResult>
    clearProjectItemField: (args: ClearProjectItemFieldArgs) => Promise<GitHubProjectMutationResult>
    updateIssueBySlug: (args: UpdateIssueBySlugArgs) => Promise<GitHubProjectMutationResult>
    updatePullRequestBySlug: (
      args: UpdatePullRequestBySlugArgs
    ) => Promise<GitHubProjectMutationResult>
    addIssueCommentBySlug: (
      args: AddIssueCommentBySlugArgs
    ) => Promise<GitHubProjectCommentMutationResult>
    updateIssueCommentBySlug: (
      args: UpdateIssueCommentBySlugArgs
    ) => Promise<GitHubProjectMutationResult>
    deleteIssueCommentBySlug: (
      args: DeleteIssueCommentBySlugArgs
    ) => Promise<GitHubProjectMutationResult>
    listLabelsBySlug: (args: ListLabelsBySlugArgs) => Promise<ListLabelsBySlugResult>
    listAssignableUsersBySlug: (
      args: ListAssignableUsersBySlugArgs
    ) => Promise<ListAssignableUsersBySlugResult>
    listIssueTypesBySlug: (args: ListIssueTypesBySlugArgs) => Promise<ListIssueTypesBySlugResult>
    updateIssueTypeBySlug: (args: UpdateIssueTypeBySlugArgs) => Promise<GitHubProjectMutationResult>
  }
  linear: {
    connect: (args: {
      apiKey: string
    }) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
    disconnect: () => Promise<void>
    status: () => Promise<LinearConnectionStatus>
    testConnection: () => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
    searchIssues: (args: { query: string; limit?: number }) => Promise<LinearIssue[]>
    listIssues: (args?: {
      filter?: 'assigned' | 'created' | 'all' | 'completed'
      limit?: number
    }) => Promise<LinearIssue[]>
    createIssue: (args: {
      teamId: string
      title: string
      description?: string
    }) => Promise<
      { ok: true; id: string; identifier: string; url: string } | { ok: false; error: string }
    >
    getIssue: (args: { id: string }) => Promise<LinearIssue | null>
    updateIssue: (args: {
      id: string
      updates: LinearIssueUpdate
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    addIssueComment: (args: {
      issueId: string
      body: string
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
    issueComments: (args: { issueId: string }) => Promise<LinearComment[]>
    listTeams: () => Promise<LinearTeam[]>
    teamStates: (args: { teamId: string }) => Promise<LinearWorkflowState[]>
    teamLabels: (args: { teamId: string }) => Promise<LinearLabel[]>
    teamMembers: (args: { teamId: string }) => Promise<LinearMember[]>
  }
  starNag: {
    onShow: (callback: () => void) => () => void
    dismiss: () => Promise<void>
    complete: () => Promise<void>
    forceShow: () => Promise<void>
  }
  /** Fire-and-forget track. Loose typing at the IPC boundary on purpose —
   *  the main-side validator is the single enforcement point. Renderer call
   *  sites should import `track<N>()` from `src/renderer/src/lib/telemetry.ts`
   *  for the `EventMap`-based type safety, not reach for this directly. */
  telemetryTrack: (name: string, props: Record<string, unknown>) => Promise<void>
  /** Flip the persisted opt-in preference. Subject to a per-session
   *  consent-mutation rate limit on the main side (≤5/session). */
  telemetrySetOptIn: (optedIn: boolean) => Promise<void>
  /** Read-only view of effective consent state, including the reason if
   *  disabled (env var / user opt-out / CI / pending banner). Used by the
   *  Privacy pane to render the correct "blocked by X" helper text — env
   *  vars are main-side state the renderer cannot read directly. */
  telemetryGetConsentState: () => Promise<TelemetryConsentState>
  /** Banner ✕ — persist `optedIn = true` silently, emit nothing. Deliberately
   *  a separate channel from `telemetrySetOptIn` because main's `via`
   *  derivation on that channel would tag this path as `first_launch_banner`
   *  and fire `telemetry_opted_in`, which the ✕-as-silent-acknowledge
   *  semantics forbid (the user did not explicitly opt in, they declined to
   *  intervene). Subject to the same per-session consent-mutation rate
   *  limit as `telemetrySetOptIn`. */
  telemetryAcknowledgeBanner: () => Promise<void>
  settings: {
    get: () => Promise<GlobalSettings>
    set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
    listFonts: () => Promise<string[]>
    previewGhosttyImport: () => Promise<GhosttyImportPreview>
    /** Subscribe to out-of-band settings updates (e.g. the View > Appearance
     *  menu toggles) so the renderer can stay in sync with main's persisted
     *  state without round-tripping through settings:get. */
    onChanged: (callback: (updates: Partial<GlobalSettings>) => void) => () => void
  }
  codexAccounts: {
    list: () => Promise<CodexRateLimitAccountsState>
    add: () => Promise<CodexRateLimitAccountsState>
    reauthenticate: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
    remove: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
    select: (args: { accountId: string | null }) => Promise<CodexRateLimitAccountsState>
  }
  claudeAccounts: {
    list: () => Promise<ClaudeRateLimitAccountsState>
    add: () => Promise<ClaudeRateLimitAccountsState>
    reauthenticate: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
    remove: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
    select: (args: { accountId: string | null }) => Promise<ClaudeRateLimitAccountsState>
  }
  cli: {
    getInstallStatus: () => Promise<CliInstallStatus>
    install: () => Promise<CliInstallStatus>
    remove: () => Promise<CliInstallStatus>
  }
  agentHooks: {
    claudeStatus: () => Promise<AgentHookInstallStatus>
    codexStatus: () => Promise<AgentHookInstallStatus>
    geminiStatus: () => Promise<AgentHookInstallStatus>
    cursorStatus: () => Promise<AgentHookInstallStatus>
  }
  agentTrust: {
    markTrusted: (args: { preset: 'cursor' | 'copilot'; workspacePath: string }) => Promise<void>
  }
  preflight: PreflightApi
  notifications: {
    dispatch: (args: NotificationDispatchRequest) => Promise<NotificationDispatchResult>
    openSystemSettings: () => Promise<void>
    getPermissionStatus: () => Promise<NotificationPermissionStatusResult>
    requestPermission: () => Promise<NotificationPermissionStatusResult>
    playSound: (options?: { force?: boolean }) => Promise<NotificationSoundResult>
  }
  onboarding: {
    get: () => Promise<OnboardingState>
    // Why: main-process `updateOnboarding` merges checklist field-by-field, so
    // callers can pass a partial checklist (e.g. just `{ addedRepo: true }`)
    // without re-supplying every flag.
    update: (
      updates: Partial<Omit<OnboardingState, 'checklist'>> & {
        checklist?: Partial<OnboardingState['checklist']>
      }
    ) => Promise<OnboardingState>
  }
  developerPermissions: {
    getStatus: () => Promise<DeveloperPermissionState[]>
    request: (args: { id: DeveloperPermissionId }) => Promise<DeveloperPermissionRequestResult>
    openSettings: (args: { id: DeveloperPermissionId }) => Promise<void>
  }
  shell: {
    openPath: (path: string) => Promise<void>
    openUrl: (url: string) => Promise<void>
    openFilePath: (path: string) => Promise<void>
    openFileUri: (uri: string) => Promise<void>
    pathExists: (path: string) => Promise<boolean>
    pickAttachment: () => Promise<string | null>
    pickImage: () => Promise<string | null>
    pickAudio: () => Promise<string | null>
    pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
    copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
  }
  pet: {
    import: () => Promise<CustomPet | null>
    importPetBundle: () => Promise<CustomPet | null>
    read: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<ArrayBuffer | null>
    delete: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<void>
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
    check: (options?: { includePrerelease?: boolean }) => Promise<void>
    download: () => Promise<void>
    quitAndInstall: () => Promise<void>
    dismissNudge: () => Promise<void>
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
    onClearDismissal: (callback: () => void) => () => void
  }
  stats: StatsApi
  memory: MemoryApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  fs: {
    readDir: (args: { dirPath: string; connectionId?: string }) => Promise<DirEntry[]>
    readFile: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }>
    listMarkdownDocuments: (args: {
      rootPath: string
      connectionId?: string
    }) => Promise<MarkdownDocument[]>
    writeFile: (args: { filePath: string; content: string; connectionId?: string }) => Promise<void>
    createFile: (args: { filePath: string; connectionId?: string }) => Promise<void>
    createDir: (args: { dirPath: string; connectionId?: string }) => Promise<void>
    rename: (args: { oldPath: string; newPath: string; connectionId?: string }) => Promise<void>
    deletePath: (args: {
      targetPath: string
      connectionId?: string
      recursive?: boolean
    }) => Promise<void>
    authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
    stat: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
    }) => Promise<string[]>
    search: (args: SearchOptions & { connectionId?: string }) => Promise<SearchResult>
    importExternalPaths: (args: {
      sourcePaths: string[]
      destDir: string
      connectionId?: string
    }) => Promise<{
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
    resolveDroppedPathsForAgent: (args: {
      paths: string[]
      worktreePath: string
      connectionId?: string
    }) => Promise<{
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
  git: {
    status: (args: { worktreePath: string; connectionId?: string }) => Promise<GitStatusResult>
    conflictOperation: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<GitConflictOperation>
    diff: (args: {
      worktreePath: string
      filePath: string
      staged: boolean
      compareAgainstHead?: boolean
      connectionId?: string
    }) => Promise<GitDiffResult>
    branchCompare: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
    }) => Promise<GitBranchCompareResult>
    upstreamStatus: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<GitUpstreamStatus>
    fetch: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    push: (args: {
      worktreePath: string
      publish?: boolean
      connectionId?: string
    }) => Promise<void>
    pull: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
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
    commit: (args: {
      worktreePath: string
      message: string
      connectionId?: string
    }) => Promise<{ success: boolean; error?: string }>
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
    onOpenNewWorkspace: (callback: () => void) => () => void
    onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
    onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
    onNewBrowserTab: (callback: () => void) => () => void
    onRequestTabCreate: (
      callback: (data: {
        requestId: string
        url: string
        worktreeId?: string
        sessionProfileId?: string
      }) => void
    ) => () => void
    replyTabCreate: (reply: { requestId: string; browserPageId?: string; error?: string }) => void
    onRequestTabSetProfile: (
      callback: (data: { requestId: string; browserPageId: string; profileId: string }) => void
    ) => () => void
    replyTabSetProfile: (reply: { requestId: string; error?: string }) => void
    onRequestTabClose: (
      callback: (data: { requestId: string; tabId: string | null; worktreeId?: string }) => void
    ) => () => void
    replyTabClose: (reply: { requestId: string; error?: string }) => void
    onNewTerminalTab: (callback: () => void) => () => void
    onFocusBrowserAddressBar: (callback: () => void) => () => void
    onFindInBrowserPage: (callback: () => void) => () => void
    onReloadBrowserPage: (callback: () => void) => () => void
    onHardReloadBrowserPage: (callback: () => void) => () => void
    onCloseActiveTab: (callback: () => void) => () => void
    onSwitchTab: (callback: (direction: 1 | -1) => void) => () => void
    onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void) => () => void
    onSwitchTerminalTab: (callback: (direction: 1 | -1) => void) => () => void
    onToggleStatusBar: (callback: () => void) => () => void
    onExportPdfRequested: (callback: () => void) => () => void
    onActivateWorktree: (
      callback: (data: {
        repoId: string
        worktreeId: string
        setup?: WorktreeSetupLaunch
        startup?: WorktreeStartupLaunch
      }) => void
    ) => () => void
    onCreateTerminal: (
      callback: (data: { worktreeId: string; command?: string; title?: string }) => void
    ) => () => void
    onRequestTerminalCreate: (
      callback: (data: {
        requestId: string
        worktreeId?: string
        command?: string
        title?: string
      }) => void
    ) => () => void
    replyTerminalCreate: (reply: {
      requestId: string
      tabId?: string
      title?: string
      error?: string
    }) => void
    onSplitTerminal: (
      callback: (data: {
        tabId: string
        paneRuntimeId: number
        direction: 'horizontal' | 'vertical'
        command?: string
      }) => void
    ) => () => void
    onRenameTerminal: (
      callback: (data: { tabId: string; title: string | null }) => void
    ) => () => void
    onFocusTerminal: (callback: (data: { tabId: string; worktreeId: string }) => void) => () => void
    onCloseTerminal: (
      callback: (data: { tabId: string; paneRuntimeId?: number }) => void
    ) => () => void
    onSleepWorktree: (callback: (data: { worktreeId: string }) => void) => () => void
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
    setMarkdownEditorFocused: (focused: boolean) => void
    onRichMarkdownContextCommand: (
      callback: (payload: RichMarkdownContextMenuCommandPayload) => void
    ) => () => void
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
    minimize: () => void
    maximize: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
    requestClose: () => void
    popupMenu: () => void
    onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
    confirmWindowClose: () => void
  }
  runtime: {
    syncWindowGraph: (graph: RuntimeSyncWindowGraph) => Promise<RuntimeStatus>
    getStatus: () => Promise<RuntimeStatus>
    getTerminalFitOverrides: () => Promise<
      { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[]
    >
    restoreTerminalFit: (ptyId: string) => Promise<{ restored: boolean }>
    onTerminalFitOverrideChanged: (
      callback: (event: {
        ptyId: string
        mode: 'mobile-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    ) => () => void
    onTerminalDriverChanged: (
      callback: (event: {
        ptyId: string
        driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
      }) => void
    ) => () => void
  }
  rateLimits: {
    get: () => Promise<RateLimitState>
    refresh: () => Promise<RateLimitState>
    setPollingInterval: (ms: number) => Promise<void>
    fetchInactiveClaudeAccounts: () => Promise<void>
    fetchInactiveCodexAccounts: () => Promise<void>
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
    needsPassphrasePrompt: (args: { targetId: string }) => Promise<boolean>
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
    }) => Promise<PortForwardEntry>
    updatePortForward: (args: {
      id: string
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }) => Promise<PortForwardEntry>
    removePortForward: (args: { id: string }) => Promise<PortForwardEntry | null>
    listPortForwards: (args?: { targetId?: string }) => Promise<PortForwardEntry[]>
    listDetectedPorts: (args: { targetId: string }) => Promise<DetectedPort[]>
    onPortForwardsChanged: (
      callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
    ) => () => void
    onDetectedPortsChanged: (
      callback: (data: { targetId: string; ports: DetectedPort[] }) => void
    ) => () => void
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
  wsl: {
    isAvailable: () => Promise<boolean>
  }
  pwsh: {
    isAvailable: () => Promise<boolean>
  }
  agentStatus: {
    /** Listen for agent status updates forwarded from native hook receivers. */
    onSet: (
      callback: (data: {
        paneKey: string
        tabId?: string
        worktreeId?: string
        state: AgentStatusState
        prompt?: string
        agentType?: string
        toolName?: string
        toolInput?: string
        lastAssistantMessage?: string
        interrupted?: boolean
      }) => void
    ) => () => void
  }
  mobile: {
    listNetworkInterfaces: () => Promise<{
      interfaces: { name: string; address: string }[]
    }>
    getPairingQR: (args?: { address?: string }) => Promise<
      | { available: false }
      | {
          available: true
          qrDataUrl: string
          pairingUrl: string
          endpoint: string
          deviceId: string
        }
    >
    listDevices: () => Promise<{
      devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
    }>
    revokeDevice: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
    isWebSocketReady: () => Promise<{ ready: boolean; endpoint: string | null }>
  }
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
