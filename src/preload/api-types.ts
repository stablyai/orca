/* eslint-disable max-lines -- Why: the preload contract is intentionally centralized in one declaration file so renderer and preload stay in lockstep when IPC surfaces change. */
import type {
  CreateHostedReviewArgs,
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchArgs,
  HostedReviewInfo,
  HostedReviewProvider
} from '../shared/hosted-review'
import type { NativeFileDropPayload } from '../shared/native-file-drop'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../shared/terminal-tab-close'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../shared/local-log-tail-types'
import type { ReadClipboardTextOptions } from '../shared/clipboard-text'
import type { AppIdentity } from '../shared/app-identity'
import type { MobileRelayStatus } from '../shared/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../shared/mobile-pairing-connection-mode'
import type {
  CreateLocalOrcaProfileArgs,
  CreateLocalOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  ConnectCurrentOrcaProfileResult,
  FindOrcaProfileProjectsByPathArgs,
  FindOrcaProfileProjectsByPathResult,
  OrcaProfileListResult,
  OrcaProfileAuthStatus,
  RefreshCurrentOrcaProfileAuthResult,
  SelectOrcaProfileOrgArgs,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult,
  SwitchOrcaProfileArgs,
  SwitchOrcaProfileResult,
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult,
  OrcaProfileOrgInviteRevokeArgs,
  OrcaProfileOrgMemberChangeRoleArgs,
  OrcaProfileOrgMemberInviteArgs,
  OrcaProfileOrgMemberMutationResult,
  OrcaProfileOrgMemberRemoveArgs,
  OrcaProfileOrgMembersListArgs,
  OrcaProfileOrgMembersListResult
} from '../shared/orca-profiles'
import type { TerminalPaneSplitSource } from '../shared/feature-education-telemetry'
import type { TaskSourceContext } from '../shared/task-source-context'
import type { LinearIssueAttributeFilter } from '../shared/linear-issue-attribute-filter'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../shared/codex-startup-delivery'
import type { SleepingAgentLaunchConfig } from '../shared/agent-session-resume'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../shared/localhost-worktree-labels'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../shared/folder-workspace-path-status'
import type {
  BaseRefDefaultResult,
  BaseRefSearchResult,
  BrowserCookieImportResult,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileScope,
  BrowserSessionProfileSource,
  BrowserViewportOverride,
  ClaudeRateLimitAccountsState,
  ClassifiedError,
  CodexRateLimitAccountsState,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  CustomPet,
  DetectedWorktreeListResult,
  DirEntry,
  ForceDeleteWorktreeBranchResult,
  FsChangedPayload,
  GhosttyImportPreview,
  GlobalSettings,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitForkSyncExpectedUpstream,
  GitForkSyncResult,
  GitPushTarget,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus,
  GitHubAssignableUser,
  GitHubCreateIssueResult,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubPrStartPoint,
  GitHubPRReviewCommentInput,
  GitHubCommentResult,
  GitHubOwnerRepo,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubViewer,
  GitLabAssignableUser,
  GitLabAuthDiagnostic,
  GitLabCommentResult,
  GitLabDiscussionResolveResult,
  GitLabIssueInfo,
  GitLabIssueUpdate,
  GitLabJobTraceResult,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  GitLabMRUpdate,
  GitLabProjectRef,
  GitLabRetryJobResult,
  GitLabTodo,
  GitLabViewer,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  GetGitLabRateLimitResult,
  ListMergeRequestsResult,
  MRInfo,
  MRListState,
  ListWorkItemsResult,
  IssueInfo,
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateIssueArgs,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraProjectStatusOrder,
  JiraIssueUpdate,
  JiraPriority,
  JiraProject,
  JiraSiteSelection,
  JiraTransition,
  JiraUser,
  JiraViewer,
  LinearViewer,
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearWorkspaceSelection,
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearWorkflowState,
  LinearLabel,
  LinearMember,
  LinearProjectDetail,
  LinearProjectSummary,
  LinearTeam,
  MarkdownDocument,
  FloatingTerminalCwdRequest,
  GitHubIssueUpdate,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GetRateLimitResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationPermissionStatusResult,
  NotificationSoundResult,
  OnboardingState,
  OrcaHooks,
  PathSource,
  PersistedUIState,
  PRCheckDetail,
  PRCheckRunDetails,
  PRComment,
  PRInfo,
  PRRefreshOutcome,
  Project,
  ProjectUpdateArgs,
  Repo,
  ProjectGroup,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  FolderWorkspace,
  ProjectGroupImportResult,
  ProjectGroupImportMode,
  ShellHydrationFailureReason,
  SparsePreset,
  SearchOptions,
  NestedRepoScanResult,
  SearchResult,
  StatsSummary,
  MemorySnapshot,
  TuiAgent,
  UpdateCheckOptions,
  UpdateStatus,
  Worktree,
  WorktreeBaseStatusEvent,
  WorktreeHeadIdentity,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeMeta,
  WorktreeRemoteBranchConflictEvent,
  RemoveWorktreeResult,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../shared/types'
import type { PtyModelRestoreNeededEvent } from '../shared/pty-model-restore-marker'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../shared/terminal-view-attributes'
import type { PtyMainDeliveryDiagnostics } from '../shared/pty-delivery-diagnostics'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../shared/terminal-custom-themes'

import type { SetupScriptImportCandidate } from '../shared/setup-script-imports'
import type { GitHistoryOptions, GitHistoryResult } from '../shared/git-history'
import type { PublicKnownRuntimeEnvironment } from '../shared/runtime-environments'
import type {
  EphemeralVmRecipeDoctorResult,
  EphemeralVmRecipeResultWarning
} from '../shared/ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { RuntimeAccessGrant } from '../shared/runtime-access-grants'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'
import type { ExecutionHostId } from '../shared/execution-host'
import type { FeatureInteractionId } from '../shared/feature-interactions'
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
import type { BrowserSetAnnotationViewportBridgeArgs } from '../shared/browser-annotation-viewport-bridge'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type { E2EConfig } from '../shared/e2e-config'
import type { AgentHookInstallStatus } from '../shared/agent-hook-types'
import type {
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../shared/agent-interrupt-intent'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import type {
  RuntimeBrowserDriverState,
  RuntimeMobileSessionTabMove,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeSyncWindowGraph,
  RuntimeTerminalCreateRequestPayload,
  RuntimeTerminalDriverState,
  RuntimeTerminalPresentation
} from '../shared/runtime-types'
import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../shared/source-control-ai'
import type { SourceControlAiSettings } from '../shared/source-control-ai-types'
import type { ShellOpenLocalPathResult } from '../shared/shell-open-types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../shared/skills'
import type { SkillFreshnessInventory } from '../shared/skill-freshness'
import type {
  CrashReportBreadcrumbData,
  CrashReportCopyDiagnosticsArgs,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../shared/crash-reporting'

export type { ShellOpenLocalPathResult } from '../shared/shell-open-types'

type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../shared/mobile-markdown-document'
import type {
  DeveloperPermissionId,
  DeveloperPermissionRequestResult,
  DeveloperPermissionState
} from '../shared/developer-permissions-types'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../shared/computer-use-permissions-types'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRange,
  ClaudeUsageScanState,
  ClaudeUsageScope,
  ClaudeUsageSessionRow,
  ClaudeUsageSnapshot,
  ClaudeUsageSummary
} from '../shared/claude-usage-types'
import type {
  CodexRateLimitResetResult,
  GrokAccountStatus,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../shared/rate-limit-types'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../shared/speech-types'
import type {
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceScanProgress
} from '../shared/workspace-space-types'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortScanRequest,
  WorkspacePortScanResult
} from '../shared/workspace-ports'
import type { GhAuthDiagnostic } from '../shared/github-auth-types'
import type {
  SshConnectionState,
  SshConfigImportResult,
  SshTargetAddResult,
  SshTarget,
  PortForwardEntry,
  EnrichedDetectedPort
} from '../shared/ssh-types'
import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageRange,
  CodexUsageScanState,
  CodexUsageScope,
  CodexUsageSessionRow,
  CodexUsageSnapshot,
  CodexUsageSummary
} from '../shared/codex-usage-types'
import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageDailyPoint,
  OpenCodeUsageRange,
  OpenCodeUsageScanState,
  OpenCodeUsageScope,
  OpenCodeUsageSessionRow,
  OpenCodeUsageSnapshot,
  OpenCodeUsageSummary
} from '../shared/opencode-usage-types'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../shared/ai-vault-types'
import type { AgentType, NativeChatMessage } from '../shared/native-chat-types'
import type { TelemetryConsentState } from '../shared/telemetry-consent-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'
import type { AppStarSource } from '../shared/gh-star-source'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceConnectedClient,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../shared/remote-workspace-types'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationCreateInput,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput,
  AutomationRun,
  AutomationPrecheckResult,
  AutomationUpdateInput
} from '../shared/automations-types'
import type {
  WorkspaceCleanupDismissArgs,
  WorkspaceCleanupLocalProcessArgs,
  WorkspaceCleanupLocalProcessResult,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../shared/workspace-cleanup'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../shared/keybindings'

type GitLabRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

type GitHubRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

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
  setAnnotationViewportBridge: (args: BrowserSetAnnotationViewportBridgeArgs) => Promise<boolean>
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
  onActivateView: (
    callback: (data: { worktreeId?: string; browserPageId?: string }) => void
  ) => () => void
  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
  ) => () => void
  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string }) => void
  ) => () => void
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

export type EmulatorApi = {
  onPaneFocus: (callback: (data: { worktreeId: string }) => void) => () => void
  onAutoAttach: (
    callback: (data: {
      worktreeId: string
      info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
    }) => void
  ) => () => void
  startFrameStream: (args: { streamUrl: string; streamKey?: string }) => Promise<{
    streamId: string
  }>
  stopFrameStream: (args: { streamId: string }) => Promise<void>
  onFrameStreamFrame: (
    callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
  ) => () => void
  onFrameStreamError: (
    callback: (data: { streamId: string; message: string }) => void
  ) => () => void
  startVideoStream: (args: { deviceId: string; streamId: string }) => Promise<{ streamId: string }>
  stopVideoStream: (args: { streamId: string }) => Promise<void>
  onVideoStreamMeta: (
    callback: (data: {
      streamId: string
      deviceId: string
      meta: { codecId: string; width: number; height: number }
    }) => void
  ) => () => void
  onVideoStreamFrame: (
    callback: (data: {
      streamId: string
      deviceId: string
      config: boolean
      keyFrame: boolean
      bytes: ArrayBuffer
    }) => void
  ) => () => void
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
  /** Optional — older preload payloads predating GitLab support don't
   *  include it. Consumers gate on `glab?.installed` / `authenticated`. */
  glab?: { installed: boolean; authenticated: boolean }
  bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
  azureDevOps?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
  gitea?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
}

export type RefreshAgentsResult = {
  agents: string[]
  addedPathSegments: string[]
  shellHydrationOk: boolean
  /** Why: drives the agent_picks `on_path:false` triage in dashboard 1562016
   *  (insight A). `'shell_hydrate'` = detection saw the user's full shell PATH;
   *  `'sync_seed_only'` = hydration failed and detection ran against the
   *  seed list from `patchPackagedProcessPath`. */
  pathSource: PathSource
  /** Why: classified hydration outcome. `'none'` on success; one of the failure
   *  modes when `shellHydrationOk` is false. Typed off the shared alias so
   *  schema/main/preload/renderer stay in lockstep. */
  pathFailureReason: ShellHydrationFailureReason
}

export type PreflightRuntimeContext = {
  wslDistro?: string | null
  wslDefault?: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
}

export type PreflightApi = {
  check: (args?: PreflightRuntimeContext & { force?: boolean }) => Promise<PreflightStatus>
  detectAgents: (args?: PreflightRuntimeContext) => Promise<string[]>
  refreshAgents: (args?: PreflightRuntimeContext) => Promise<RefreshAgentsResult>
  detectRemoteAgents: (args: { connectionId: string }) => Promise<string[]>
  detectRemoteWindowsTerminalCapabilities: (args: { connectionId: string }) => Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }>
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
  // `degraded` is true when the daemon is alive but cannot spawn fresh PTYs, so
  // new terminals run on the local provider without daemon persistence.
  listSessions: () => Promise<{ sessions: PtyManagementSession[]; degraded: boolean }>
  killAll: () => Promise<{
    killedCount: number
    remainingCount: number
    killedSessionIds?: string[]
  }>
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

// Diagnostics — error-tracking-lane payload shapes that cross the IPC
// boundary. Mirror the runtime types in
// `src/main/observability/{index,bundle}.ts`. Kept here, not imported,
// because the preload api-types file is the source of truth for the
// renderer's view of the IPC surface.
export type DiagnosticsStatusPayload = {
  readonly localFileEnabled: boolean
  readonly bundleEnabled: boolean
  readonly traceFilePath: string
  readonly traceFamilySize: number
  readonly disabledReason?:
    | 'do_not_track'
    | 'orca_telemetry_disabled'
    | 'orca_diagnostics_disabled'
    | 'ci'
}
export type DiagnosticsBundlePayload = {
  readonly bundleSubmissionId: string
  readonly bytes: number
  readonly spanCount: number
}
export type DiagnosticsUploadPayload =
  | {
      readonly ticketId: string
    }
  | {
      readonly canceled: true
    }

export type MemoryApi = {
  getSnapshot: () => Promise<MemorySnapshot>
}

export type ClaudeUsageApi = {
  getScanState: () => Promise<ClaudeUsageScanState>
  setEnabled: (args: { enabled: boolean }) => Promise<ClaudeUsageScanState>
  refresh: (args?: { force?: boolean }) => Promise<ClaudeUsageScanState>
  getSnapshot: (args: {
    scope: ClaudeUsageScope
    range: ClaudeUsageRange
    limit?: number
  }) => Promise<ClaudeUsageSnapshot>
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
  getSnapshot: (args: {
    scope: CodexUsageScope
    range: CodexUsageRange
    limit?: number
  }) => Promise<CodexUsageSnapshot>
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

export type OpenCodeUsageApi = {
  getScanState: () => Promise<OpenCodeUsageScanState>
  setEnabled: (args: { enabled: boolean }) => Promise<OpenCodeUsageScanState>
  refresh: (args?: { force?: boolean }) => Promise<OpenCodeUsageScanState>
  getSnapshot: (args: {
    scope: OpenCodeUsageScope
    range: OpenCodeUsageRange
    limit?: number
  }) => Promise<OpenCodeUsageSnapshot>
  getSummary: (args: {
    scope: OpenCodeUsageScope
    range: OpenCodeUsageRange
  }) => Promise<OpenCodeUsageSummary>
  getDaily: (args: {
    scope: OpenCodeUsageScope
    range: OpenCodeUsageRange
  }) => Promise<OpenCodeUsageDailyPoint[]>
  getBreakdown: (args: {
    scope: OpenCodeUsageScope
    range: OpenCodeUsageRange
    kind: OpenCodeUsageBreakdownKind
  }) => Promise<OpenCodeUsageBreakdownRow[]>
  getRecentSessions: (args: {
    scope: OpenCodeUsageScope
    range: OpenCodeUsageRange
    limit?: number
  }) => Promise<OpenCodeUsageSessionRow[]>
}

export type AiVaultApi = {
  listSessions: (args?: AiVaultListArgs) => Promise<AiVaultListResult>
  /** Lists the Task subagent transcripts of one session, on demand. */
  listSubagentSessions: (args: AiVaultSubagentListArgs) => Promise<AiVaultSubagentListResult>
  /** Fires when any app window regains OS focus; returns an unsubscribe. */
  onWindowFocused: (callback: () => void) => () => void
}

// notFound marks a miss caused by the transcript not existing on disk yet
// (retry-worthy), as opposed to a real read/parse error (#8401).
export type NativeChatReadSessionResult =
  | { messages: NativeChatMessage[] }
  | { error: string; notFound?: true }

/** Messages appended to a live-tailed transcript since the previous emit. */
export type NativeChatAppendedMessages = NativeChatMessage[]

export type NativeChatSubscriptionFrame =
  | { type: 'snapshot'; messages: NativeChatMessage[]; hasMore: boolean; error?: string }
  | { type: 'replacement'; messages: NativeChatMessage[]; hasMore: boolean }
  | { type: 'appended'; messages: NativeChatMessage[] }

/** Wire payload for the `nativeChat:appended` push channel. */
export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: NativeChatSubscriptionFrame
}

export type NativeChatSubscribeArgs = {
  /** Unique per-caller id, echoed on every append so multiple live panes in
   *  one renderer don't cross-talk. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** First snapshot size; later readSession calls grow this for pagination. */
  limit?: number
}

export type NativeChatApi = {
  /** Read the on-disk transcript for an agent + session id, windowed to the most
   *  recent `limit` turns (defaults to the desktop window). The renderer raises
   *  `limit` to page in older history as it scrolls to the top. `transcriptPath`
   *  is the hook-reported authoritative file path, preferred over the id glob. */
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string
  ) => Promise<NativeChatReadSessionResult>
  /** Live-tail a transcript. The first frame is a bounded race-safe snapshot;
   *  later frames contain only newly appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
}

export type AppApi = {
  /** Returns the app identity currently exposed to native chrome and the titlebar. */
  getIdentity: () => Promise<AppIdentity>
  /** Returns a URL base for feature-wall assets. In dev this is Vite /@fs;
   *  in packaged builds this is file:// resources. Renderer appends filenames. */
  getFeatureWallAssetBaseUrl: () => Promise<string>
  /** Relaunches the app via Electron's app.relaunch() + app.exit(0). Used
   *  by settings panes that need a full restart to apply changes (e.g. the
   *  terminal-window blur setting in TerminalWindowSection). */
  relaunch: () => Promise<void>
  /** Restarts Orca through the normal quit pipeline so daemon-backed terminal
   *  sessions survive and can reattach after the new process starts. */
  restart: () => Promise<void>
  /** Reloads the current app renderer through main so expected renderer
   *  teardown can be classified before Electron emits process-gone events. */
  reload: () => Promise<void>
  /** Resolves when the daemon PTY provider and hook receiver have either
   *  started or failed open for the first BrowserWindow. */
  awaitFirstWindowStartupServices: () => Promise<void>
  /** Emits a startup benchmark marker when ORCA_STARTUP_DIAGNOSTICS is enabled. */
  startupDiagnostic: (event: string, details?: Record<string, unknown>) => Promise<void>
  /** Returns the macOS active input mode, or layout ID when no IME mode is
   *  selected (e.g. `com.apple.keylayout.PolishPro`). Used by the
   *  keyboard-layout probe to distinguish CJK IMEs and layouts whose base
   *  layer matches US QWERTY but whose Option layer composes characters
   *  (issue #1205).
   *  Returns null on non-Darwin platforms or when the defaults read fails. */
  getKeyboardInputSourceId: () => Promise<string | null>
  /** Updates the macOS Dock unread badge. No-op on Windows/Linux. */
  setUnreadDockBadgeCount: (count: number) => Promise<void>
  /** Resolves the launch directory for global Floating Terminal tabs. */
  getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest) => Promise<string>
  /** Resolves Orca's app-owned directory for auto-created Floating Workspace
   *  markdown notes. */
  getFloatingMarkdownDirectory: () => Promise<string>
  /** Opens a native picker for markdown documents, rooted in the floating
   *  workspace, and authorizes the selected file for editor reads/writes. */
  pickFloatingMarkdownDocument: () => Promise<MarkdownDocument | null>
  /** Opens a native directory picker and authorizes the selected directory
   *  for Floating Workspace markdown file creation. */
  pickFloatingWorkspaceDirectory: () => Promise<string | null>
}

export type PreloadApi = {
  app: AppApi
  orcaProfiles: {
    list: () => Promise<OrcaProfileListResult>
    authStatus: () => Promise<OrcaProfileAuthStatus>
    createLocal: (args?: CreateLocalOrcaProfileArgs) => Promise<CreateLocalOrcaProfileResult>
    createCloudLinked: (
      args?: CreateCloudLinkedOrcaProfileArgs
    ) => Promise<CreateCloudLinkedOrcaProfileResult>
    switchProfile: (args: SwitchOrcaProfileArgs) => Promise<SwitchOrcaProfileResult>
    transferProject: (
      args: TransferOrcaProfileProjectArgs
    ) => Promise<TransferOrcaProfileProjectResult>
    findProjectProfiles: (
      args: FindOrcaProfileProjectsByPathArgs
    ) => Promise<FindOrcaProfileProjectsByPathResult>
    connectCurrent: () => Promise<ConnectCurrentOrcaProfileResult>
    refreshAuth: () => Promise<RefreshCurrentOrcaProfileAuthResult>
    signOutCurrent: () => Promise<SignOutCurrentOrcaProfileResult>
    selectOrg: (args: SelectOrcaProfileOrgArgs) => Promise<SelectOrcaProfileOrgResult>
    orgMembersList: (
      args: OrcaProfileOrgMembersListArgs
    ) => Promise<OrcaProfileOrgMembersListResult>
    orgMemberInvite: (
      args: OrcaProfileOrgMemberInviteArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
    orgInviteRevoke: (
      args: OrcaProfileOrgInviteRevokeArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
    orgMemberChangeRole: (
      args: OrcaProfileOrgMemberChangeRoleArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
    orgMemberRemove: (
      args: OrcaProfileOrgMemberRemoveArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
  }
  platform: {
    get: () => {
      platform: NodeJS.Platform
      osRelease: string
      displayServer: 'wayland' | 'x11' | null
    }
  }
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
    // Forget a project on one execution host only, leaving the same repo id on
    // other hosts (local or a re-added SSH target) intact.
    removeForHost: (args: { repoId: string; hostId: string }) => Promise<void>
    reorder: (args: { orderedIds: string[] }) => Promise<{ status: 'applied' | 'rejected' }>
    reorderForHost: (args: {
      orderedIds: string[]
      hostId: string
    }) => Promise<{ status: 'applied' | 'rejected' }>
    update: (args: {
      repoId: string
      updates: Partial<
        Pick<
          Repo,
          | 'displayName'
          | 'badgeColor'
          | 'repoIcon'
          | 'upstream'
          | 'hookSettings'
          | 'worktreeBaseRef'
          | 'worktreeBasePath'
          | 'kind'
          | 'issueSourcePreference'
          | 'externalWorktreeVisibility'
          | 'externalWorktreeVisibilityPromptDismissedAt'
          | 'externalWorktreeInboxBaselinePaths'
          | 'importedExternalWorktreePaths'
          | 'projectGroupId'
          | 'projectGroupOrder'
          | 'forkSyncMode'
        >
      > & {
        sourceControlAi?: Repo['sourceControlAi'] | null
        externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
      }
    }) => Promise<Repo>
    pickFolder: () => Promise<string | null>
    pickFolders: () => Promise<string[]>
    pickDirectory: () => Promise<string | null>
    clone: (args: { url: string; destination: string }) => Promise<Repo>
    cloneRemote: (args: { connectionId: string; url: string; destination: string }) => Promise<Repo>
    createRemote: (args: {
      connectionId: string
      parentPath: string
      name: string
      kind: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
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
    isGitAvailable: () => Promise<boolean>
    getDefaultCreateProjectParent: () => Promise<string>
    onCloneProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void
    getGitUsername: (args: { repoId: string }) => Promise<string>
    getBaseRefDefault: (args: {
      repoId: string
      hostId?: ExecutionHostId
    }) => Promise<BaseRefDefaultResult>
    searchBaseRefs: (args: {
      repoId: string
      query: string
      limit?: number
      hostId?: ExecutionHostId
    }) => Promise<string[]>
    searchBaseRefDetails: (args: {
      repoId: string
      query: string
      limit?: number
      hostId?: ExecutionHostId
    }) => Promise<BaseRefSearchResult[]>
    onChanged: (callback: () => void) => () => void
  }
  projects: {
    list: () => Promise<Project[]>
    update: (args: ProjectUpdateArgs) => Promise<Project | null>
    listHostSetups: () => Promise<ProjectHostSetup[]>
    createHostSetup: (args: ProjectHostSetupCreateArgs) => Promise<ProjectHostSetupCreateResult>
    setupExistingFolder: (
      args: ProjectHostSetupExistingFolderArgs
    ) => Promise<ProjectHostSetupResult>
    updateHostSetup: (args: ProjectHostSetupUpdateArgs) => Promise<ProjectHostSetupUpdateResult>
    deleteHostSetup: (args: ProjectHostSetupDeleteArgs) => Promise<ProjectHostSetupDeleteResult>
  }
  projectGroups: {
    list: () => Promise<ProjectGroup[]>
    create: (args: {
      name: string
      parentPath?: string | null
      connectionId?: string | null
      parentGroupId?: string | null
      createdFrom?: ProjectGroup['createdFrom']
    }) => Promise<ProjectGroup>
    update: (args: {
      groupId: string
      updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
    }) => Promise<ProjectGroup | null>
    delete: (args: { groupId: string }) => Promise<boolean>
    moveProject: (args: {
      projectId: string
      groupId: string | null
      order?: number
    }) => Promise<Repo | null>
    scanNested: (args: {
      path: string
      connectionId?: string
      scanId?: string
      options?: Record<string, unknown>
    }) => Promise<NestedRepoScanResult>
    cancelNestedScan: (args: { scanId: string }) => Promise<boolean>
    onNestedScanProgress: (
      callback: (data: { scanId: string; scan: NestedRepoScanResult }) => void
    ) => () => void
    importNested: (args: {
      parentPath: string
      groupName: string
      projectPaths: string[]
      connectionId?: string
      scanId?: string
      mode: ProjectGroupImportMode
    }) => Promise<ProjectGroupImportResult>
  }
  folderWorkspaces: {
    list: () => Promise<FolderWorkspace[]>
    getPathStatus: (args: FolderWorkspacePathStatusRequest) => Promise<FolderWorkspacePathStatus>
    create: (args: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
      linkedTask?: FolderWorkspace['linkedTask']
      createdWithAgent?: FolderWorkspace['createdWithAgent']
      pendingFirstAgentMessageRename?: boolean
    }) => Promise<FolderWorkspace>
    update: (args: {
      folderWorkspaceId: string
      updates: Partial<
        Pick<
          FolderWorkspace,
          | 'name'
          | 'folderPath'
          | 'linkedTask'
          | 'comment'
          | 'isArchived'
          | 'isUnread'
          | 'isPinned'
          | 'sortOrder'
          | 'manualOrder'
          | 'workspaceStatus'
          | 'createdWithAgent'
          | 'pendingFirstAgentMessageRename'
          | 'firstAgentMessageRenameError'
          | 'lastActivityAt'
        >
      >
    }) => Promise<FolderWorkspace | null>
    delete: (args: { folderWorkspaceId: string }) => Promise<boolean>
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
    listDetected: (args: { repoId: string }) => Promise<DetectedWorktreeListResult>
    listAll: () => Promise<Worktree[]>
    create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
    /** Two-phase progress for a background `create`, correlated by
     *  `creationId`. Renderer routes each event to its pending creation's
     *  status surface; the remote/runtime create path emits nothing, so the
     *  surface falls back to an indeterminate spinner. */
    onCreateProgress: (
      callback: (data: { creationId?: string; phase: 'fetching' | 'creating' }) => void
    ) => () => void
    prefetchCreateBase: (args: { repoId: string; baseBranch?: string }) => Promise<void>
    resolvePrBase: (args: {
      repoId: string
      prNumber: number
      headRefName?: string
      baseRefName?: string
      isCrossRepository?: boolean
    }) => Promise<GitHubPrStartPoint | { error: string }>
    /** GitLab parallel of resolvePrBase. For same-project MRs returns
     *  `<remote>/<source_branch>`; for fork MRs fetches
     *  refs/merge-requests/<iid>/head and returns the SHA. */
    resolveMrBase: (args: {
      repoId: string
      mrIid: number
      sourceBranch?: string
      targetBranch?: string
      isCrossRepository?: boolean
    }) => Promise<
      | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
      | { error: string }
    >
    remove: (args: {
      worktreeId: string
      hostId?: ExecutionHostId
      force?: boolean
      skipArchive?: boolean
    }) => Promise<RemoveWorktreeResult>
    // Forget a workspace from Orca only — no remote Git/filesystem work. Used
    // for workspaces pinned to a removed/disconnected SSH host.
    forgetLocal: (args: {
      worktreeId: string
      hostId?: ExecutionHostId
    }) => Promise<RemoveWorktreeResult>
    forceDeletePreservedBranch: (args: {
      worktreeId: string
      branchName: string
      expectedHead: string
    }) => Promise<ForceDeleteWorktreeBranchResult>
    updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
    listLineage: () => Promise<{
      lineage: Record<string, WorktreeLineage>
      workspaceLineage?: Record<string, WorkspaceLineage>
    }>
    updateLineage: (args: {
      worktreeId: string
      parentWorktreeId?: string
      noParent?: boolean
    }) => Promise<WorktreeLineage | null>
    persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
    /** Full CLI output of the last branch auto-rename generation failure, held
     *  in main memory only — null after a restart or once the failure clears. */
    getBranchRenameFailureOutput: (args: { worktreeId: string }) => Promise<string | null>
    onChanged: (callback: (data: { repoId: string }) => void) => () => void
    onGitStatusMetadataChanged: (callback: (data: { repoId: string }) => void) => () => void
    onHeadIdentitiesChanged: (
      callback: (data: { repoId: string; identities: WorktreeHeadIdentity[] }) => void
    ) => () => void
    onBaseStatus: (callback: (data: WorktreeBaseStatusEvent) => void) => () => void
    onRemoteBranchConflict: (
      callback: (data: WorktreeRemoteBranchConflictEvent) => void
    ) => () => void
  }
  workspaceCleanup: {
    scan: (
      args?: WorkspaceCleanupScanArgs,
      onProgress?: (progress: WorkspaceCleanupScanProgress) => void
    ) => Promise<WorkspaceCleanupScanResult>
    dismiss: (args: WorkspaceCleanupDismissArgs) => Promise<void>
    clearDismissals: () => Promise<void>
    hasKillableLocalProcesses: (
      args: WorkspaceCleanupLocalProcessArgs
    ) => Promise<WorkspaceCleanupLocalProcessResult>
  }
  workspaceSpace: {
    analyze: () => Promise<WorkspaceSpaceAnalyzeResult>
    cancel: () => Promise<boolean>
    onProgress: (callback: (progress: WorkspaceSpaceScanProgress) => void) => () => void
  }
  workspacePorts: {
    scan: (args: WorkspacePortScanRequest) => Promise<WorkspacePortScanResult>
    kill: (args: WorkspacePortKillRequest) => Promise<WorkspacePortKillResult>
    onAdvertisedUrlChanged: (
      callback: (event: WorkspacePortAdvertisedUrlChangedEvent) => void
    ) => () => void
  }
  pty: {
    spawn: (opts: {
      cols: number
      rows: number
      cwd?: string
      cwdFallback?: 'worktree'
      env?: Record<string, string>
      command?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
      launchAgent?: TuiAgent
      startupCommandDelivery?: StartupCommandDelivery
      connectionId?: string | null
      worktreeId?: string
      sessionId?: string
      // Why: lets a single tab open in a different shell than the user's default.
      // Preserved from the deleted index.d.ts PtyApi duplicate during the
      // single-source-of-truth collapse (see docs/preload-typecheck-hole.md §1).
      shellOverride?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
      terminalColorQueryReplies?: { foreground?: string; background?: string }
      // Why: hidden-at-spawn declaration — main marks the PTY hidden before
      // its first byte so the delivery gate + model responder own spawn-time
      // queries (terminal-query-authority.md §races).
      initiallyHidden?: boolean
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
      launchAgent?: TuiAgent
      launchConfig?: SleepingAgentLaunchConfig
      snapshot?: string
      snapshotCols?: number
      snapshotRows?: number
      isReattach?: boolean
      isAlternateScreen?: boolean
      replay?: string
      sessionExpired?: boolean
      coldRestore?: { scrollback: string; cwd: string }
      startupCwdFallback?: { kind: 'worktree'; cwd: string }
    }>
    write: (id: string, data: string) => void
    writeAccepted: (id: string, data: string) => Promise<boolean>
    resize: (id: string, cols: number, rows: number) => void
    claimViewport: (id: string, cols: number, rows: number) => void
    reportGeometry: (id: string, cols: number, rows: number) => void
    signal: (id: string, signal: string) => void
    clearBuffer: (id: string) => void
    kill: (id: string, opts?: { keepHistory?: boolean }) => Promise<void>
    ackColdRestore: (id: string) => void
    ackData: (id: string, charCount: number, processedChars?: number) => void
    onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void) => () => void
    respondDeliveryResync: (payload: {
      requestId: number
      processedCharsByPty: Record<string, number>
    }) => void
    /** Renderer-initiated delivery health/heal lane over invoke — reaches main
     *  even when every main→renderer push channel is dead (field wedge). */
    reportRendererDeliveryState: (
      report: PtyRendererDeliveryStateReport
    ) => Promise<PtyRendererDeliveryHealthReply>
    /** Live pty:data listener count on the preload emitter (sync) — heal-time
     *  discriminator between a detached listener and a dead channel. */
    getPtyDataListenerCount: () => number
    /** One-shot signal that this page's pty:data dispatcher is registered, so
     *  main can release sends held during the load/reload boot window. */
    rendererDispatcherReady: () => void
    setActiveRendererPty: (id: string, active: boolean) => void
    setRendererPtyVisible: (id: string, visible: boolean) => void
    /** Hidden-delivery gate (Phase 4): hidden=true lets main drop renderer
     *  byte delivery after model ingestion; reveal restores from snapshots. */
    setHiddenRendererPty: (id: string, hidden: boolean) => void
    /** Ref-counted-on-the-renderer delivery-interest signal that suppresses
     *  the hidden-delivery gate while any raw-byte consumer is registered. */
    setPtyDeliveryInterest: (id: string, interested: boolean) => void
    /** View-attribute bridge (Phase 5 slice 2): app-global composed terminal
     *  appearance push backing main's hidden-PTY OSC/DSR color replies. */
    publishTerminalViewAttributes: (attributes: TerminalViewAttributes) => void
    hasChildProcesses: (id: string) => Promise<boolean>
    getForegroundProcess: (id: string) => Promise<string | null>
    confirmForegroundProcess: (id: string) => Promise<string | null>
    getCwd: (id: string) => Promise<string>
    getSize: (id: string) => Promise<{ cols: number; rows: number } | null>
    listSessions: () => Promise<{ id: string; cwd: string; title: string }[]>
    getAuthoritativeBufferSnapshotCapabilities?: (
      ids: string[]
    ) => { id: string; authoritative: boolean | null }[]
    hasPty: (id: string) => Promise<boolean | null>
    getMainBufferSnapshot: (
      id: string,
      opts?: { scrollbackRows?: number }
    ) => Promise<{
      data: string
      cols: number
      rows: number
      cwd?: string | null
      seq?: number
      /** Start of main's pending renderer-delivery queue at snapshot time
       *  (equals `seq` when empty) — bounds the renderer's post-restore
       *  duplicate window. */
      pendingDeliveryStartSeq?: number
      source?: 'headless' | 'renderer'
      alternateScreen?: boolean
      /** Authoritative normal buffer paired with an alternate-screen frame. */
      scrollbackAnsi?: string
      /** Trailing incomplete escape the emulator ingested; the restorer must
       *  write it after its post-replay resets, last before live chunks. */
      pendingEscapeTailAnsi?: string
    } | null>
    getRendererDeliveryDebugSnapshot: () => Promise<{
      pendingPtyCount: number
      pendingChars: number
      maxPendingCharsByPty: number
      rendererInFlightPtyCount: number
      rendererInFlightChars: number
      maxRendererInFlightCharsByPty: number
      activeRendererPtyCount: number
      flushScheduled: boolean
      peakPendingChars: number
      peakMaxPendingCharsByPty: number
      peakRendererInFlightChars: number
      peakMaxRendererInFlightCharsByPty: number
      ackGatedFlushSkipCount: number
      hiddenDeliveryGatedPtyCount: number
      hiddenDeliveryGatedVisiblePtyCount: number
      hiddenDeliveryGatedActivePtyCount: number
      deliveryInterestPtyCount: number
      hiddenDeliveryDroppedChars: number
      hiddenDeliveryDroppedChunks: number
      pendingDroppedChars: number
      diagnostics: PtyMainDeliveryDiagnostics
      rendererLifecycleResetCount: number
      lastLifecycleResetClearedChars: number
      rendererPtyDispatcherReady: boolean
      rendererDispatcherReadyForcedCount: number
    }>
    resetRendererDeliveryDebug: () => Promise<void>
    onData: (
      callback: (data: {
        id: string
        data: string
        seq?: number
        rawLength?: number
        background?: boolean
        droppedOutput?: boolean
      }) => void
    ) => () => void
    onReplay: (callback: (data: { id: string; data: string }) => void) => () => void
    /** Out-of-band main→renderer signal that renderer-bound bytes were
     *  dropped (hidden-delivery gate / pending cap); the pane restores from
     *  the model snapshot. Never delivered in-band on pty:data. */
    onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void) => () => void
    /** Batched derived side-effect facts for PTYs whose bytes transit local
     *  main; see docs/reference/terminal-side-effect-authority.md. */
    onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void) => () => void
    /** Title-only replay snapshot for (re)attach; attention facts never replay. */
    getSideEffectSnapshot: (id: string) => Promise<TerminalSideEffectBatch | null>
    onExit: (callback: (data: { id: string; code: number }) => void) => () => void
    onSerializeBufferRequest: (
      callback: (data: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      }) => void
    ) => () => void
    onClearBufferRequest: (callback: (data: { ptyId: string }) => void) => () => void
    sendSerializedBuffer: (
      requestId: string,
      snapshot: {
        data: string
        cols: number
        rows: number
        seq?: number
        lastTitle?: string
      } | null
    ) => void
    declarePendingPaneSerializer: (paneKey: string) => Promise<number>
    settlePaneSerializer: (paneKey: string, gen: number) => Promise<void>
    clearPendingPaneSerializer: (paneKey: string, gen: number) => Promise<void>
    reportRendererSerializerReady?: (ptyId: string) => Promise<void>
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
  crashReports: {
    getLatestPending: () => Promise<CrashReportRecord | null>
    getLatestReport: () => Promise<CrashReportRecord | null>
    dismiss: (args: { reportId: string }) => Promise<CrashReportRecord | null>
    recordRendererError: (
      args: ReactErrorBoundaryReportArgs
    ) => Promise<ReactErrorBoundaryReportResult>
    recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }) => void
    submit: (args: CrashReportSubmitArgs) => Promise<CrashReportSubmitResult>
    copyLatestDiagnostics: (
      args?: CrashReportCopyDiagnosticsArgs
    ) => Promise<{ ok: true } | { ok: false; error: string }>
  }
  export: ExportApi
  gh: {
    viewer: () => Promise<GitHubViewer | null>
    repoSlug: (args: {
      repoPath: string
      repoId?: string
    }) => Promise<{ owner: string; repo: string } | null>
    repoUpstream: (args: {
      repoPath: string
      repoId?: string
    }) => Promise<{ owner: string; repo: string } | null>
    prForBranch: (args: {
      repoPath: string
      repoId?: string
      branch: string
      linkedPRNumber?: number | null
      fallbackPRNumber?: number | null
      acceptMergedFallbackPR?: boolean
      currentHeadOid?: string | null
    }) => Promise<PRInfo | null>
    refreshPRNow: (args: { candidate: GitHubPRRefreshCandidate }) => Promise<PRRefreshOutcome>
    enqueuePRRefresh: (args: {
      candidate: GitHubPRRefreshCandidate
      reason: GitHubPRRefreshReason
      priority?: number
    }) => Promise<GitHubPRRefreshEnqueueResult | false>
    reportVisiblePRRefreshCandidates: (args: {
      candidates: GitHubPRRefreshCandidate[]
      generation: number
    }) => Promise<boolean>
    onPRRefreshEvent: (callback: (event: GitHubPRRefreshEvent) => void) => () => void
    issue: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
    }) => Promise<IssueInfo | null>
    workItem: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      number: number
      type?: 'issue' | 'pr'
    }) => Promise<Omit<GitHubWorkItem, 'repoId'> | null>
    workItemByOwnerRepo: (args: {
      repoPath: string
      repoId?: string
      owner: string
      repo: string
      number: number
      type: 'issue' | 'pr'
    }) => Promise<Omit<GitHubWorkItem, 'repoId'> | null>
    workItemDetails: (
      args: GitHubRepoSelectorArgs & {
        number: number
        type?: 'issue' | 'pr'
      }
    ) => Promise<GitHubWorkItemDetails | null>
    notifyWorkItemMutated: (args: {
      repoPath: string
      repoId?: string
      type: 'issue' | 'pr'
      number: number
    }) => Promise<boolean>
    prFileContents: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        path: string
        oldPath?: string
        status: GitHubPRFile['status']
        headSha: string
        baseSha: string
      }
    ) => Promise<GitHubPRFileContents>
    listIssues: (args: {
      repoPath: string
      repoId?: string
      limit?: number
    }) => Promise<IssueInfo[]>
    createIssue: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      title: string
      body: string
      labels?: string[]
      assignees?: string[]
    }) => Promise<GitHubCreateIssueResult>
    countWorkItems: (args: { repoPath: string; repoId?: string; query?: string }) => Promise<number>
    listWorkItems: (args: {
      repoPath: string
      repoId?: string
      limit?: number
      query?: string
      page?: number
      noCache?: boolean
    }) => Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>>
    prChecks: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        headSha?: string
        prRepo?: GitHubOwnerRepo | null
        noCache?: boolean
      }
    ) => Promise<PRCheckDetail[]>
    prCheckDetails: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: GitHubOwnerRepo | null
    }) => Promise<PRCheckRunDetails | null>
    rerunPRChecks: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        headSha?: string
        failedOnly?: boolean
      }
    ) => Promise<{ ok: true; count: number } | { ok: false; error: string }>
    prComments: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      noCache?: boolean
    }) => Promise<PRComment[]>
    resolveReviewThread: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
      threadId: string
      resolve: boolean
    }) => Promise<boolean>
    setPRFileViewed: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        pullRequestId: string
        path: string
        viewed: boolean
      }
    ) => Promise<boolean>
    updatePRTitle: (args: {
      repoPath: string
      repoId?: string
      prNumber: number
      title: string
      prRepo?: GitHubOwnerRepo | null
    }) => Promise<boolean>
    mergePR: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        method?: 'merge' | 'squash' | 'rebase'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    setPRAutoMerge: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        enabled: boolean
        method?: 'merge' | 'squash' | 'rebase'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    updatePRState: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        updates: { state: 'open' | 'closed' }
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    requestPRReviewers: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        reviewers: string[]
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    removePRReviewers: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        reviewers: string[]
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    updateIssue: (
      args: GitHubRepoSelectorArgs & {
        number: number
        updates: GitHubIssueUpdate
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    addIssueComment: (
      args: GitHubRepoSelectorArgs & {
        number: number
        body: string
        /** Why: GitHub stores PR conversation comments under `/issues/N/comments`
         *  too, so the IPC and `gh` call paths are identical. The renderer cache
         *  key is keyed by the drawer's `type`, so callers pass it through to
         *  scope the cross-window invalidation broadcast correctly and avoid
         *  evicting an unrelated PR/issue that happens to share the number. */
        type?: 'issue' | 'pr'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => Promise<GitHubCommentResult>
    addPRReviewCommentReply: (
      args: GitHubRepoSelectorArgs & {
        prNumber: number
        commentId: number
        body: string
        threadId?: string
        path?: string
        line?: number
        prRepo?: GitHubOwnerRepo | null
      }
    ) => Promise<GitHubCommentResult>
    addPRReviewComment: (
      args: GitHubPRReviewCommentInput & {
        repoId?: string
        sourceContext?: TaskSourceContext | null
      }
    ) => Promise<GitHubCommentResult>
    listLabels: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
    }) => Promise<string[]>
    listAssignableUsers: (args: {
      repoPath: string
      repoId?: string
      sourceContext?: TaskSourceContext | null
    }) => Promise<GitHubAssignableUser[]>
    /**
     * Subscribe to local-mutation broadcasts. Used by the work-item-drawer
     * cache to invalidate entries across windows after a successful mutation.
     * Returns an unsubscribe function.
     */
    onWorkItemMutated: (
      callback: (payload: {
        repoPath: string
        repoId?: string
        type: 'issue' | 'pr'
        number: number
      }) => void
    ) => () => void
    checkOrcaStarred: () => Promise<boolean | null>
    starOrca: (source: AppStarSource) => Promise<boolean>
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
  hostedReview: {
    forBranch: (args: HostedReviewForBranchArgs) => Promise<HostedReviewInfo | null>
    getCreationEligibility: (
      args: HostedReviewCreationEligibilityArgs
    ) => Promise<HostedReviewCreationEligibility>
    create: (args: CreateHostedReviewArgs) => Promise<CreateHostedReviewResult>
  }
  // ── GitLab — parallel to gh, MR/issue surface only in v1 ────────
  // Shapes mirror gh.* one-to-one where the data matches; diverge
  // where GitLab's API differs (MR state values, project path with
  // host, paginated envelope from `glab api -i`).
  gl: {
    viewer: () => Promise<GitLabViewer | null>
    diagnoseAuth: () => Promise<GitLabAuthDiagnostic>
    rateLimit: (args?: {
      force?: boolean
      host?: string | null
    }) => Promise<GetGitLabRateLimitResult>
    projectSlug: (args: GitLabRepoSelectorArgs) => Promise<GitLabProjectRef | null>
    mrForBranch: (
      args: GitLabRepoSelectorArgs & {
        branch: string
        linkedMRIid?: number | null
      }
    ) => Promise<MRInfo | null>
    mr: (args: GitLabRepoSelectorArgs & { iid: number }) => Promise<MRInfo | null>
    listMRs: (
      args: GitLabRepoSelectorArgs & {
        state?: MRListState
        page?: number
        perPage?: number
        query?: string
      }
    ) => Promise<ListMergeRequestsResult>
    /** Combined MR + issue list filtered by state. Issues are skipped
     *  when state is 'merged' (issues don't merge). */
    listWorkItems: (
      args: GitLabRepoSelectorArgs & {
        state?: MRListState
        page?: number
        perPage?: number
        query?: string
      }
    ) => Promise<ListMergeRequestsResult>
    issue: (args: GitLabRepoSelectorArgs & { number: number }) => Promise<GitLabIssueInfo | null>
    listIssues: (
      args: GitLabRepoSelectorArgs & {
        state?: 'opened' | 'closed' | 'all'
        assignee?: string
        limit?: number
      }
    ) => Promise<{ items: GitLabWorkItem[]; error?: ClassifiedError }>
    createIssue: (
      args: GitLabRepoSelectorArgs & {
        title: string
        body: string
      }
    ) => Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>
    updateIssue: (
      args: GitLabRepoSelectorArgs & {
        number: number
        updates: GitLabIssueUpdate
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    addIssueComment: (
      args: GitLabRepoSelectorArgs & {
        number: number
        body: string
      }
    ) => Promise<GitLabCommentResult>
    listLabels: (args: GitLabRepoSelectorArgs) => Promise<string[]>
    listAssignableUsers: (args: GitLabRepoSelectorArgs) => Promise<GitLabAssignableUser[]>
    /** Cross-project user-scoped todos (gitlab.com/dashboard/todos). */
    todos: (args: GitLabRepoSelectorArgs) => Promise<GitLabTodo[]>
    /** Aggregated dialog payload — body + discussions + pipeline jobs. */
    workItemDetails: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        type: 'issue' | 'mr'
      }
    ) => Promise<GitLabWorkItemDetails | null>
    closeMR: (
      args: GitLabRepoSelectorArgs & {
        iid: number
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    reopenMR: (
      args: GitLabRepoSelectorArgs & {
        iid: number
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    mergeMR: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        method?: 'merge' | 'squash' | 'rebase'
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    updateMR: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        updates: GitLabMRUpdate
      }
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    updateMRReviewers: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        reviewerIds: number[]
        projectRef?: GitLabProjectRef | null
      }
    ) => Promise<GitLabMRReviewersUpdateResult>
    addMRComment: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        body: string
      }
    ) => Promise<GitLabCommentResult>
    addMRInlineComment: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        input: GitLabMRInlineCommentInput
        projectRef?: GitLabProjectRef | null
      }
    ) => Promise<GitLabCommentResult>
    resolveMRDiscussion: (
      args: GitLabRepoSelectorArgs & {
        iid: number
        discussionId: string
        resolved: boolean
      }
    ) => Promise<GitLabDiscussionResolveResult>
    jobTrace: (
      args: GitLabRepoSelectorArgs & {
        jobId: number
        projectRef?: GitLabProjectRef | null
      }
    ) => Promise<GitLabJobTraceResult>
    retryJob: (
      args: GitLabRepoSelectorArgs & {
        jobId: number
        projectRef?: GitLabProjectRef | null
      }
    ) => Promise<GitLabRetryJobResult>
    workItemByPath: (
      args: GitLabRepoSelectorArgs & {
        host: string
        path: string
        iid: number
        type: 'issue' | 'mr'
      }
    ) => Promise<Omit<GitLabWorkItem, 'repoId'> | null>
  }
  linear: {
    connect: (args: {
      apiKey: string
    }) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
    disconnect: (args?: { workspaceId?: string }) => Promise<void>
    selectWorkspace: (args: {
      workspaceId: LinearWorkspaceSelection
    }) => Promise<LinearConnectionStatus>
    status: () => Promise<LinearConnectionStatus>
    testConnection: (args?: {
      workspaceId?: string
    }) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
    searchIssues: (args: {
      query: string
      limit?: number
      workspaceId?: LinearWorkspaceSelection
    }) => Promise<LinearIssue[]>
    listIssues: (args?: {
      filter?: 'assigned' | 'created' | 'all' | 'completed'
      limit?: number
      workspaceId?: LinearWorkspaceSelection
      attributeFilter?: LinearIssueAttributeFilter
    }) => Promise<LinearCollectionResult<LinearIssue>>
    createIssue: (args: {
      teamId: string
      title: string
      description?: string
      workspaceId?: string
      parentIssueId?: string
      projectId?: string | null
      stateId?: string
      priority?: number
      assigneeId?: string | null
      labelIds?: string[]
    }) => Promise<
      | { ok: true; id: string; identifier: string; title: string; url: string }
      | { ok: false; error: string }
    >
    getIssue: (args: { id: string; workspaceId?: string }) => Promise<LinearIssue | null>
    updateIssue: (args: {
      id: string
      updates: LinearIssueUpdate
      workspaceId?: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    addIssueComment: (args: {
      issueId: string
      body: string
      workspaceId?: string
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
    issueComments: (args: { issueId: string; workspaceId?: string }) => Promise<LinearComment[]>
    listTeams: (args?: { workspaceId?: LinearWorkspaceSelection }) => Promise<LinearTeam[]>
    listProjects: (args?: {
      query?: string
      limit?: number
      workspaceId?: LinearWorkspaceSelection
      force?: boolean
    }) => Promise<LinearCollectionResult<LinearProjectSummary>>
    createProject: (args: {
      name: string
      description?: string
      content?: string
      teamIds: string[]
      workspaceId?: string
      leadId?: string | null
      memberIds?: string[]
      labelIds?: string[]
      priority?: number
      startDate?: string
      targetDate?: string
    }) => Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }>
    getProject: (args: {
      id: string
      workspaceId: string
      force?: boolean
    }) => Promise<LinearProjectDetail | null>
    listProjectIssues: (args: {
      projectId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }) => Promise<LinearCollectionResult<LinearIssue>>
    listCustomViews: (args: {
      model: LinearCustomViewModel
      limit?: number
      workspaceId?: LinearWorkspaceSelection
      force?: boolean
    }) => Promise<LinearCollectionResult<LinearCustomViewSummary>>
    getCustomView: (args: {
      viewId: string
      model: LinearCustomViewModel
      workspaceId: string
      force?: boolean
    }) => Promise<LinearCustomViewSummary | null>
    listCustomViewIssues: (args: {
      viewId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }) => Promise<LinearCollectionResult<LinearIssue>>
    listCustomViewProjects: (args: {
      viewId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }) => Promise<LinearCollectionResult<LinearProjectSummary>>
    teamStates: (args: { teamId: string; workspaceId?: string }) => Promise<LinearWorkflowState[]>
    teamLabels: (args: { teamId: string; workspaceId?: string }) => Promise<LinearLabel[]>
    teamMembers: (args: { teamId: string; workspaceId?: string }) => Promise<LinearMember[]>
  }
  jira: {
    connect: (args: {
      siteUrl: string
      email: string
      apiToken: string
      authType?: 'cloud' | 'server'
    }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
    disconnect: (args?: { siteId?: string }) => Promise<void>
    selectSite: (args: { siteId: JiraSiteSelection }) => Promise<JiraConnectionStatus>
    status: () => Promise<JiraConnectionStatus>
    testConnection: (args?: {
      siteId?: string
    }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
    searchIssues: (args: {
      jql: string
      limit?: number
      siteId?: JiraSiteSelection
    }) => Promise<JiraIssue[]>
    listIssues: (args?: {
      filter?: JiraIssueFilter
      limit?: number
      siteId?: JiraSiteSelection
    }) => Promise<JiraIssue[]>
    getIssue: (args: { key: string; siteId?: string }) => Promise<JiraIssue | null>
    createIssue: (
      args: JiraCreateIssueArgs
    ) => Promise<{ ok: true; id: string; key: string; url: string } | { ok: false; error: string }>
    updateIssue: (args: {
      key: string
      updates: JiraIssueUpdate
      siteId?: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    addIssueComment: (args: {
      key: string
      body: string
      siteId?: string
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
    issueComments: (args: { key: string; siteId?: string }) => Promise<JiraComment[]>
    listProjects: (args?: { siteId?: JiraSiteSelection }) => Promise<JiraProject[]>
    listIssueTypes: (args: { projectIdOrKey: string; siteId?: string }) => Promise<JiraIssueType[]>
    listCreateFields: (args: {
      projectIdOrKey: string
      issueTypeId: string
      siteId?: string
    }) => Promise<JiraCreateField[]>
    listPriorities: (args?: { siteId?: string }) => Promise<JiraPriority[]>
    listAssignableUsers: (args: {
      key: string
      query?: string
      siteId?: string
    }) => Promise<JiraUser[]>
    listTransitions: (args: { key: string; siteId?: string }) => Promise<JiraTransition[]>
    getProjectStatusOrder: (args: {
      projectKey: string
      siteId?: string
    }) => Promise<JiraProjectStatusOrder>
  }
  starNag: {
    onShow: (
      callback: (payload?: { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }) => void
    ) => () => void
    onHide: (callback: () => void) => () => void
    dismiss: () => Promise<void>
    later: () => Promise<void>
    complete: () => Promise<void>
    disable: () => Promise<void>
    openWeb: () => Promise<void>
    starOrca: () => Promise<boolean>
    forceShow: () => Promise<void>
    agentValueMoment: () => Promise<{ status: 'ready'; mode: 'gh' | 'web' } | { status: 'skipped' }>
    showAgentValueMoment: () => Promise<void>
    onboardingCompleted: () => Promise<void>
  }
  /** Fire-and-forget track. Loose typing at the IPC boundary on purpose —
   *  the main-side validator is the single enforcement point. Renderer call
   *  sites should import `track<N>()` from `src/renderer/src/lib/telemetry.ts`
   *  for the `EventMap`-based type safety, not reach for this directly. */
  telemetryTrack: (name: string, props: Record<string, unknown>) => Promise<void>
  /** Flip the persisted opt-in preference. Subject to a per-session
   *  consent-mutation rate limit on the main side (≤5/session). */
  telemetrySetOptIn: (optedIn: boolean) => Promise<void>
  /** Diagnostic file controls. Surface for telemetry-error-tracking.md
   *  §User controls. The renderer triggers flows; main does the filesystem /
   *  network work and returns serializable metadata. Main retains collected
   *  upload payloads so the renderer can confirm without reading or
   *  substituting arbitrary bytes. */
  diagnostics: {
    getStatus: () => Promise<DiagnosticsStatusPayload>
    collectBundle: (lookbackMinutes?: number) => Promise<DiagnosticsBundlePayload>
    openBundlePreview: (bundleSubmissionId: string) => Promise<void>
    discardBundlePreview: (bundleSubmissionId: string) => Promise<void>
    uploadBundle: (bundleSubmissionId: string) => Promise<DiagnosticsUploadPayload>
    deleteBundle: (ticketId: string) => Promise<void>
  }
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
    /** Synchronous persisted-settings read for startup decisions that cannot
     *  wait for async hydration (terminal side-effect authority). Blocking
     *  IPC — call sparingly. */
    getSync: () => GlobalSettings | null
    set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
    updatePRBotAuthorOverride: (args: { author: string; isBot: boolean }) => Promise<GlobalSettings>
    listFonts: () => Promise<string[]>
    previewGhosttyImport: () => Promise<GhosttyImportPreview>
    previewWarpThemeImport: (source: WarpThemeImportSource) => Promise<WarpThemeImportPreview>
    /** Subscribe to out-of-band settings updates (e.g. the View > Appearance
     *  menu toggles) so the renderer can stay in sync with main's persisted
     *  state without round-tripping through settings:get. */
    onChanged: (callback: (updates: Partial<GlobalSettings>) => void) => () => void
  }
  localhostWorktreeLabels: {
    register: (args: LocalhostWorktreeLabelRoute) => Promise<LocalhostWorktreeLabelResult>
  }
  keybindings: {
    get: () => Promise<KeybindingFileSnapshot>
    ensureFile: () => Promise<KeybindingFileSnapshot>
    setAction: (args: {
      actionId: KeybindingActionId
      bindings: string[] | null
    }) => Promise<KeybindingFileSnapshot>
    reload: () => Promise<KeybindingFileSnapshot>
    openFile: () => Promise<KeybindingFileSnapshot>
    revealFile: () => Promise<KeybindingFileSnapshot>
    onChanged: (callback: (snapshot: KeybindingFileSnapshot) => void) => () => void
  }
  codexAccounts: {
    list: () => Promise<CodexRateLimitAccountsState>
    add: (args?: {
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }) => Promise<CodexRateLimitAccountsState>
    reauthenticate: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
    remove: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
    select: (args: {
      accountId: string | null
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }) => Promise<CodexRateLimitAccountsState>
  }
  claudeAccounts: {
    list: () => Promise<ClaudeRateLimitAccountsState>
    add: (args?: {
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }) => Promise<ClaudeRateLimitAccountsState>
    cancelPendingLogin: () => Promise<boolean>
    reauthenticate: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
    remove: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
    select: (args: {
      accountId: string | null
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }) => Promise<ClaudeRateLimitAccountsState>
  }
  cli: {
    getInstallStatus: () => Promise<CliInstallStatus>
    install: () => Promise<CliInstallStatus>
    remove: () => Promise<CliInstallStatus>
    getWslInstallStatus: (args?: { distro?: string | null }) => Promise<CliInstallStatus>
    installWsl: (args?: { distro?: string | null }) => Promise<CliInstallStatus>
    removeWsl: (args?: { distro?: string | null }) => Promise<CliInstallStatus>
  }
  agentHooks: {
    claudeStatus: () => Promise<AgentHookInstallStatus>
    openClaudeStatus: () => Promise<AgentHookInstallStatus>
    codexStatus: () => Promise<AgentHookInstallStatus>
    geminiStatus: () => Promise<AgentHookInstallStatus>
    antigravityStatus: () => Promise<AgentHookInstallStatus>
    ampStatus: () => Promise<AgentHookInstallStatus>
    cursorStatus: () => Promise<AgentHookInstallStatus>
    droidStatus: () => Promise<AgentHookInstallStatus>
    commandCodeStatus: () => Promise<AgentHookInstallStatus>
    grokStatus: () => Promise<AgentHookInstallStatus>
    copilotStatus: () => Promise<AgentHookInstallStatus>
    hermesStatus: () => Promise<AgentHookInstallStatus>
    devinStatus: () => Promise<AgentHookInstallStatus>
  }
  agentTrust: {
    markTrusted: (args: {
      preset: 'cursor' | 'copilot' | 'codex'
      workspacePath: string
      connectionId?: string
    }) => Promise<void>
  }
  preflight: PreflightApi
  notifications: {
    dispatch: (args: NotificationDispatchRequest) => Promise<NotificationDispatchResult>
    dismiss: (ids: string[]) => Promise<NotificationDismissResult>
    openSystemSettings: () => Promise<void>
    getPermissionStatus: () => Promise<NotificationPermissionStatusResult>
    probeDelivery: (args?: { force?: boolean }) => Promise<NotificationDeliveryProbeResult>
    playSound: (options?: { force?: boolean; volume?: number }) => Promise<NotificationSoundResult>
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
  computerUsePermissions: {
    getStatus: () => Promise<ComputerUsePermissionStatusResult>
    openSetup: (args?: {
      id?: ComputerUsePermissionId
    }) => Promise<ComputerUsePermissionSetupResult>
    reset: () => Promise<ComputerUsePermissionResetResult>
  }
  shell: {
    openPath: (path: string) => Promise<void>
    openInFileManager: (path: string) => Promise<ShellOpenLocalPathResult>
    openInExternalEditor: (path: string, command?: string) => Promise<ShellOpenLocalPathResult>
    openUrl: (url: string) => Promise<void>
    openFilePath: (path: string) => Promise<boolean>
    openFileUri: (uri: string) => Promise<void>
    pathExists: (path: string) => Promise<boolean>
    pickAttachment: () => Promise<string | null>
    pickImage: () => Promise<string | null>
    pickRepoIconImage: () => Promise<{ dataUrl: string; fileName: string } | null>
    pickAudio: () => Promise<string | null>
    pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
    copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
  }
  skills: {
    discover: (target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>
    freshnessInventory: () => Promise<SkillFreshnessInventory>
  }
  pet: {
    import: () => Promise<CustomPet | null>
    importPetBundle: () => Promise<CustomPet | null>
    read: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<ArrayBuffer | null>
    delete: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<void>
  }
  browser: BrowserApi
  emulator: EmulatorApi
  hooks: {
    check: (args: { repoId: string; hostId?: ExecutionHostId }) => Promise<{
      status?: 'ok' | 'error'
      hasHooks: boolean
      hooks: OrcaHooks | null
      mayNeedUpdate: boolean
    }>
    inspectSetupScriptImports: (args: { repoId: string }) => Promise<SetupScriptImportCandidate[]>
    createIssueCommandRunner: (args: {
      repoId: string
      worktreePath: string
      command: string
    }) => Promise<WorktreeSetupLaunch>
    readIssueCommand: (args: { repoId: string; hostId?: ExecutionHostId }) => Promise<{
      status?: 'ok' | 'error'
      localContent: string | null
      sharedContent: string | null
      effectiveContent: string | null
      localFilePath: string
      source: 'local' | 'shared' | 'none'
    }>
    writeIssueCommand: (args: {
      repoId: string
      content: string
      hostId?: ExecutionHostId
    }) => Promise<void>
  }
  ephemeralVm: {
    listRecipes: (args: { repoId: string }) => Promise<{
      status: 'ok' | 'error'
      repoPath: string | null
      recipes: OrcaHooks['environmentRecipes']
      diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
      message?: string
    }>
    listRecipeCatalog: () => Promise<
      {
        repoId: string
        repoName: string
        repoPath: string
        recipes: NonNullable<OrcaHooks['environmentRecipes']>
        diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
      }[]
    >
    doctor: (args: { repoId: string; recipeId: string }) => Promise<EphemeralVmRecipeDoctorResult>
    provision: (args: {
      repoId: string
      recipeId: string
      workspaceName?: string
      projectId?: string
      workspaceId?: string
      provisionId?: string
    }) => Promise<
      | {
          ok: true
          connectionType: 'orca-server'
          runtime: EphemeralVmRuntimeRecord
          environment: PublicKnownRuntimeEnvironment
          stderr: string
          warnings: EphemeralVmRecipeResultWarning[]
        }
      | {
          ok: true
          connectionType: 'ssh'
          runtime: EphemeralVmRuntimeRecord
          sshTargetId: string
          stderr: string
          warnings: EphemeralVmRecipeResultWarning[]
        }
      | { ok: false; error: string; stderr: string; stdout: string }
    >
    cancelProvision: (args: { provisionId: string }) => Promise<{ cancelled: boolean }>
    onProvisionEvent: (
      callback: (event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void
    ) => () => void
    listRuntimes: () => Promise<EphemeralVmRuntimeRecord[]>
    attachWorkspace: (args: {
      runtimeId: string
      workspaceId: string
    }) => Promise<EphemeralVmRuntimeRecord>
    suspendWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmRuntimeRecord | null>
    resumeWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmRuntimeRecord | null>
    cleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
    getCleanupCommand: (args: { runtimeId: string }) => Promise<{
      runtimeId: string
      command: string | null
      payloadJson: string
      cleanupDisabled: boolean
      message?: string
    }>
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
    // hostId is optional and defaults to the 'local' partition on the main
    // side, so existing callers that omit it behave exactly as before.
    get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
    set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
    patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
    flush: () => Promise<void>
    readTerminalScrollback: (args: { ref: string }) => string | null
    setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
  }
  remoteWorkspace: {
    get: (args: { targetId: string }) => Promise<RemoteWorkspaceSnapshot | null>
    setForConnectedTargets: (args: {
      session?: WorkspaceSessionState
      hydratedTargetIds?: string[]
    }) => Promise<{ targetId: string; result: RemoteWorkspacePatchResult }[]>
    listEnabledConnectedTargets: () => Promise<string[]>
    listConnectedClients: (args?: {
      targetIds?: string[]
    }) => Promise<{ targetId: string; clients: RemoteWorkspaceConnectedClient[] }[]>
    clientId: () => Promise<string>
    onChanged: (callback: (event: RemoteWorkspaceChangedEvent) => void) => () => void
  }
  updater: {
    getVersion: () => Promise<string>
    getStatus: () => Promise<UpdateStatus>
    check: (options?: UpdateCheckOptions) => Promise<void>
    download: () => Promise<void>
    quitAndInstall: () => Promise<void>
    dismissNudge: () => Promise<void>
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
    onClearDismissal: (callback: () => void) => () => void
  }
  notebook: {
    runPythonCell: (args: {
      filePath: string
      code: string
      preamble?: string
      connectionId?: string | null
    }) => Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }>
  }
  stats: StatsApi
  memory: MemoryApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  openCodeUsage: OpenCodeUsageApi
  aiVault: AiVaultApi
  nativeChat: NativeChatApi
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
    writeFile: (args: { filePath: string; content: string; connectionId?: string }) => Promise<void>
    createFile: (args: { filePath: string; connectionId?: string }) => Promise<void>
    createDir: (args: { dirPath: string; connectionId?: string }) => Promise<void>
    rename: (args: { oldPath: string; newPath: string; connectionId?: string }) => Promise<void>
    copy: (args: {
      sourcePath: string
      destinationPath: string
      connectionId?: string
    }) => Promise<void>
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
    pathExists: (args: { filePath: string; connectionId?: string }) => Promise<boolean>
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
      requestToken?: string
    }) => Promise<string[]>
    cancelListFiles: (args: { requestToken: string }) => Promise<void>
    search: (args: SearchOptions & { connectionId?: string }) => Promise<SearchResult>
    importExternalPaths: (args: {
      sourcePaths: string[]
      destDir: string
      connectionId?: string
      ensureDir?: boolean
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
    status: (args: {
      worktreePath: string
      connectionId?: string
      includeIgnored?: boolean
      bypassEffectiveUpstreamNegativeCache?: boolean
      reuseLineStats?: boolean
      requestToken?: string
    }) => Promise<GitStatusResult>
    cancelStatus: (args: { requestToken: string }) => Promise<void>
    submoduleStatus: (args: {
      worktreePath: string
      submodulePath: string
      connectionId?: string
      area?: GitStagingArea
    }) => Promise<GitStatusResult>
    checkIgnored: (args: {
      worktreePath: string
      paths: string[]
      connectionId?: string
    }) => Promise<string[]>
    findHugeFoldersToIgnore: (args: { worktreePath: string }) => Promise<string[]>
    appendGitignore: (args: { worktreePath: string; folderName: string }) => Promise<boolean>
    history: (
      args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
    ) => Promise<GitHistoryResult>
    conflictOperation: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<GitConflictOperation>
    abortMerge: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    abortRebase: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
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
    commitCompare: (args: {
      worktreePath: string
      commitId: string
      connectionId?: string
    }) => Promise<GitCommitCompareResult>
    upstreamStatus: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<GitUpstreamStatus>
    fetch: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    syncFork: (args: {
      worktreePath: string
      connectionId?: string
      expectedUpstream: GitForkSyncExpectedUpstream
    }) => Promise<GitForkSyncResult>
    push: (args: {
      worktreePath: string
      publish?: boolean
      forceWithLease?: boolean
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    pull: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    fastForward: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    rebaseFromBase: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
    }) => Promise<void>
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
    commitDiff: (args: {
      worktreePath: string
      commitOid: string
      parentOid?: string | null
      filePath: string
      oldPath?: string
      connectionId?: string
    }) => Promise<GitDiffResult>
    commit: (args: {
      worktreePath: string
      message: string
      connectionId?: string
    }) => Promise<{ success: boolean; error?: string }>
    generateCommitMessage: (args: {
      worktreePath: string
      repoId?: string
      connectionId?: string
      sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
      sourceControlAi?: SourceControlAiSettings
      agentCmdOverrides?: Partial<Record<TuiAgent, string>>
    }) => Promise<
      | { success: true; message: string; agentLabel?: string }
      | { success: false; error: string; canceled?: boolean }
    >
    discoverCommitMessageModels: (args: {
      agentId: string
      worktreePath?: string
      connectionId?: string
    }) => Promise<
      | {
          success: true
          capability: CommitMessageAgentCapability
          models: CommitMessageModelCapability[]
          defaultModelId: string
        }
      | { success: false; error: string }
    >
    cancelGenerateCommitMessage: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<void>
    generatePullRequestFields: (args: {
      worktreePath: string
      repoId?: string
      base: string
      title: string
      body: string
      draft: boolean
      provider?: HostedReviewProvider
      useTemplate?: boolean
      connectionId?: string
      sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
      sourceControlAi?: SourceControlAiSettings
      agentCmdOverrides?: Partial<Record<TuiAgent, string>>
    }) => Promise<
      | {
          success: true
          fields: { base: string; title: string; body: string; draft: boolean }
          agentLabel?: string
          branchChangedByPreparation?: boolean
        }
      | { success: false; error: string; canceled?: boolean; branchChangedByPreparation?: boolean }
    >
    cancelGeneratePullRequestFields: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<void>
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
    bulkDiscard: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }) => Promise<void>
    remoteFileUrl: (args: {
      worktreePath: string
      relativePath: string
      line: number
      connectionId?: string
    }) => Promise<string | null>
    remoteCommitUrl: (args: {
      worktreePath: string
      sha: string
      connectionId?: string
    }) => Promise<string | null>
  }
  ui: {
    get: () => Promise<PersistedUIState>
    set: (args: Partial<PersistedUIState>) => Promise<void>
    recordFeatureInteraction: (id: FeatureInteractionId) => Promise<PersistedUIState>
    onStateChanged: (callback: (ui: PersistedUIState) => void) => () => void
    onOpenSettings: (callback: () => void) => () => void
    /** Consumes a one-shot tray/menu-bar "open settings" intent queued before mount. */
    consumePendingOpenSettings: () => Promise<boolean>
    onOpenSetupGuide: (callback: () => void) => () => void
    onOpenFeatureTour: (callback: () => void) => () => void
    onOpenCrashReport: (callback: () => void) => () => void
    onToggleLeftSidebar: (callback: () => void) => () => void
    onToggleRightSidebar: (callback: () => void) => () => void
    onToggleWorktreePalette: (callback: () => void) => () => void
    onToggleFloatingTerminal: (callback: () => void) => () => void
    onTerminalShortcutCaptured: (
      callback: (data: { actionId: KeybindingActionId }) => void
    ) => () => void
    onOpenQuickOpen: (callback: () => void) => () => void
    onToggleQuickCommandsMenu: (callback: () => void) => () => void
    onOpenNewWorkspace: (callback: () => void) => () => void
    onDeleteCurrentWorkspace: (callback: () => void) => () => void
    onOpenWorkspaceBoard: (callback: () => void) => () => void
    onOpenTasks: (callback: () => void) => () => void
    onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
    onJumpToTabIndex: (callback: (index: number) => void) => () => void
    onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
    onNewBrowserTab: (callback: () => void) => () => void
    onNewMarkdownTab: (callback: () => void) => () => void
    onNewSimulatorTab: (callback: () => void) => () => void
    onRequestTabCreate: (
      callback: (data: {
        requestId: string
        url: string
        worktreeId?: string
        sessionProfileId?: string | null
        sessionPartition?: string
        activate?: boolean
      }) => void
    ) => () => void
    replyTabCreate: (reply: { requestId: string; browserPageId?: string; error?: string }) => void
    onRequestTabSetProfile: (
      callback: (data: {
        requestId: string
        browserPageId: string
        profileId: string
        sessionPartition?: string
      }) => void
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
    onBrowserHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
    onZoomBrowserPage: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
    onHardReloadBrowserPage: (callback: () => void) => () => void
    onCloseActiveTab: (callback: () => void) => () => void
    onSwitchTab: (callback: (direction: 1 | -1) => void) => () => void
    onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void) => () => void
    onSwitchRecentTab: (callback: () => void) => () => void
    onSwitchTerminalTab: (callback: (direction: 1 | -1) => void) => () => void
    onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void) => () => void
    onCtrlTabKeyUp: (callback: () => void) => () => void
    onToggleStatusBar: (callback: () => void) => () => void
    onDictationKeyDown: (callback: () => void) => () => void
    onExportPdfRequested: (callback: () => void) => () => void
    onAppMenuPaste: (callback: () => void) => () => void
    onEditableContextPaste: (callback: (data: { plainTextOnly: boolean }) => void) => () => void
    onActivateWorktree: (
      callback: (data: {
        repoId: string
        worktreeId: string
        setup?: WorktreeSetupLaunch
        startup?: WorktreeStartupLaunch
        defaultTabs?: WorktreeDefaultTabsLaunch
      }) => void
    ) => () => void
    onCreateTerminal: (
      callback: (data: {
        requestId?: string
        worktreeId: string
        command?: string
        cwd?: string
        env?: Record<string, string>
        launchConfig?: SleepingAgentLaunchConfig
        launchToken?: string
        launchAgent?: TuiAgent
        viewMode?: 'terminal' | 'chat'
        title?: string
        ptyId?: string
        activate?: boolean
        presentation?: RuntimeTerminalPresentation
        tabId?: string
        leafId?: string
        splitFromLeafId?: string
        splitDirection?: 'horizontal' | 'vertical'
        splitTelemetrySource?: TerminalPaneSplitSource
      }) => void
    ) => () => void
    onRequestTerminalCreate: (
      callback: (data: RuntimeTerminalCreateRequestPayload) => void
    ) => () => void
    onRequestTerminalTabMount: (
      callback: (data: { worktreeId: string; tabId?: string; ptyId?: string }) => void
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
        telemetrySource?: TerminalPaneSplitSource
      }) => void
    ) => () => void
    onRenameTerminal: (
      callback: (data: { tabId: string; title: string | null }) => void
    ) => () => void
    onFocusTerminal: (
      callback: (data: {
        tabId: string
        worktreeId: string
        leafId?: string | null
        ackPaneKeyOnSuccess?: string
        flashFocusedPane?: boolean
        scrollToBottomIfOutputSinceLastView?: boolean
      }) => void
    ) => () => void
    onFocusEditorTab: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ) => () => void
    onCloseSessionTab: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ) => () => void
    onMoveSessionTab: (
      callback: (data: { worktreeId: string } & RuntimeMobileSessionTabMove) => void
    ) => () => void
    onOpenFileFromMobile: (
      callback: (data: {
        worktreeId: string
        filePath: string
        relativePath: string
        runtimeEnvironmentId?: string
      }) => void
    ) => () => void
    onOpenDiffFromMobile: (
      callback: (data: {
        worktreeId: string
        filePath: string
        relativePath: string
        staged: boolean
        runtimeEnvironmentId?: string
      }) => void
    ) => () => void
    onMobileMarkdownRequest: (
      callback: (request: RuntimeMobileMarkdownRequest) => void
    ) => () => void
    respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse) => void
    onCloseTerminal: (
      callback: (data: { tabId: string; paneRuntimeId?: number }) => void
    ) => () => void
    onTerminalTabCloseRequest: (callback: (request: TerminalTabCloseRequest) => void) => () => void
    respondTerminalTabClose: (response: TerminalTabCloseResponse) => void
    onSleepWorktree: (callback: (data: { worktreeId: string }) => void) => () => void
    onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void) => () => void
    onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
    onSystemResumed: (callback: () => void) => () => void
    readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
    readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
    saveClipboardImageAsTempFile: (args?: {
      connectionId?: string | null
      runtimeEnvironmentId?: string | null
    }) => Promise<string | null>
    writeClipboardText: (text: string) => Promise<void>
    writeSelectionClipboardText: (text: string) => Promise<void>
    writeClipboardImage: (dataUrl: string) => Promise<void>
    performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
    writeClipboardFile: (
      args:
        | {
            filePath: string
            connectionId?: string | null
          }
        | string
    ) => Promise<{ ok: boolean; reason?: string }>
    onFileDrop: (callback: (data: NativeFileDropPayload) => void) => () => void
    getZoomLevel: () => number
    setZoomLevel: (level: number) => void
    syncTrafficLights: (zoomFactor: number) => void
    setMarkdownEditorFocused: (focused: boolean) => void
    setTerminalInputFocused: (focused: boolean) => void
    setFloatingTerminalInputFocused: (focused: boolean) => void
    setShortcutRecorderFocused: (focused: boolean) => void
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
    syncWindowGraph: (graph: RuntimeSyncWindowGraph) => Promise<RuntimeSyncWindowGraphResult>
    getStatus: () => Promise<RuntimeStatus>
    call: (args: { method: string; params?: unknown }) => Promise<RuntimeRpcResponse<unknown>>
    getTerminalFitOverrides: () => Promise<
      { ptyId: string; mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }[]
    >
    getTerminalDrivers: () => Promise<
      {
        ptyId: string
        driver: RuntimeTerminalDriverState
      }[]
    >
    getBrowserDrivers: () => Promise<
      {
        browserPageId: string
        driver: RuntimeBrowserDriverState
      }[]
    >
    restoreTerminalFit: (ptyId: string) => Promise<{ restored: boolean }>
    reclaimBrowserForDesktop: (browserPageId: string) => Promise<{ reclaimed: boolean }>
    onTerminalFitOverrideChanged: (
      callback: (event: {
        ptyId: string
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    ) => () => void
    onTerminalDriverChanged: (
      callback: (event: { ptyId: string; driver: RuntimeTerminalDriverState }) => void
    ) => () => void
    onBrowserDriverChanged: (
      callback: (event: { browserPageId: string; driver: RuntimeBrowserDriverState }) => void
    ) => () => void
  }
  runtimeEnvironments: {
    list: () => Promise<PublicKnownRuntimeEnvironment[]>
    addFromPairingCode: (args: {
      name: string
      pairingCode: string
    }) => Promise<{ environment: PublicKnownRuntimeEnvironment }>
    resolve: (args: { selector: string }) => Promise<PublicKnownRuntimeEnvironment>
    remove: (args: { selector: string }) => Promise<{ removed: PublicKnownRuntimeEnvironment }>
    disconnect: (args: {
      selector: string
    }) => Promise<{ disconnected: PublicKnownRuntimeEnvironment }>
    getStatus: (args: {
      selector: string
      timeoutMs?: number
    }) => Promise<RuntimeRpcResponse<RuntimeStatus>>
    call: (args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
    }) => Promise<RuntimeRpcResponse<unknown>>
    subscribe: (
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
      },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onError?: (error: { code: string; message: string }) => void
        onClose?: () => void
      }
    ) => Promise<RuntimeEnvironmentSubscriptionHandle>
  }
  rateLimits: {
    get: () => Promise<RateLimitState>
    refresh: () => Promise<RateLimitState>
    refreshCodexForTarget: (target: RateLimitRuntimeTarget) => Promise<RateLimitState>
    consumeCodexResetCredit: () => Promise<CodexRateLimitResetResult>
    refreshClaudeForTarget: (target: RateLimitRuntimeTarget) => Promise<RateLimitState>
    setPollingInterval: (ms: number) => Promise<void>
    fetchInactiveClaudeAccounts: () => Promise<void>
    fetchInactiveCodexAccounts: () => Promise<void>
    refreshMiniMax: () => Promise<RateLimitState>
    refreshGrok: () => Promise<RateLimitState>
    onUpdate: (callback: (state: RateLimitState) => void) => () => void
  }
  minimaxCredentials: {
    getStatus: () => Promise<{ configured: boolean }>
    saveCookie: (cookie: string) => Promise<{ configured: boolean }>
    clearCookie: () => Promise<{ configured: boolean }>
  }
  grokAccounts: {
    getStatus: () => Promise<GrokAccountStatus>
  }
  ssh: {
    listTargets: () => Promise<SshTarget[]>
    // Removed-target id → last known label, for showing a friendly host name on
    // workspaces still pinned to a target that no longer exists.
    listRemovedTargetLabels: () => Promise<Record<string, string>>
    addTarget: (args: { target: Omit<SshTarget, 'id'> }) => Promise<SshTargetAddResult>
    updateTarget: (args: {
      id: string
      updates: Partial<Omit<SshTarget, 'id'>>
    }) => Promise<SshTarget>
    removeTarget: (args: { id: string }) => Promise<void>
    importConfig: (args?: { reAdopt?: boolean }) => Promise<SshConfigImportResult>
    connect: (args: { targetId: string }) => Promise<SshConnectionState | null>
    disconnect: (args: { targetId: string }) => Promise<void>
    terminateSessions: (args: { targetId: string }) => Promise<void>
    resetRelay: (args: { targetId: string }) => Promise<void>
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
    listDetectedPorts: (args: { targetId: string }) => Promise<EnrichedDetectedPort[]>
    onPortForwardsChanged: (
      callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
    ) => () => void
    onDetectedPortsChanged: (
      callback: (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
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
  automations: {
    list: () => Promise<Automation[]>
    listRuns: (args?: { automationId?: string }) => Promise<AutomationRun[]>
    listExternalManagers: () => Promise<ExternalAutomationManager[]>
    listExternalRuns: (input: ExternalAutomationRunsInput) => Promise<ExternalAutomationRunsPage>
    createExternal: (input: ExternalAutomationCreateInput) => Promise<void>
    updateExternal: (input: ExternalAutomationUpdateInput) => Promise<void>
    runExternalAction: (input: ExternalAutomationActionInput) => Promise<void>
    create: (input: AutomationCreateInput) => Promise<Automation>
    update: (args: { id: string; updates: AutomationUpdateInput }) => Promise<Automation>
    delete: (args: { id: string }) => Promise<void>
    runNow: (args: { id: string }) => Promise<AutomationRun>
    runPrecheck: (args: {
      automationId: string
      runId: string
    }) => Promise<AutomationPrecheckResult | null>
    markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
    snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }) => Promise<number>
    rendererReady: () => Promise<void>
    onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void) => () => void
  }
  wsl: {
    isAvailable: () => Promise<boolean>
    listDistros: () => Promise<string[]>
  }
  pwsh: {
    isAvailable: () => Promise<boolean>
  }
  gitBash: {
    isAvailable: () => Promise<boolean>
  }
  agentStatus: {
    /** Listen for agent status updates forwarded from native hook receivers. */
    onSet: (callback: (data: AgentStatusIpcPayload) => void) => () => void
    /** Listen for main-process pane teardown that evicted a cached hook status. */
    onClear: (callback: (data: { paneKey: string }) => void) => () => void
    /** Return the current main-process hook cache after renderer hydration. */
    getSnapshot: () => Promise<AgentStatusIpcPayload[]>
    inferInterrupt: (request: AgentInterruptInferenceRequest) => Promise<boolean>
    /** Listen for PTYs that still use a legacy numeric pane key but have
     *  registry-backed UUID pane proof. */
    onMigrationUnsupported: (callback: (entry: MigrationUnsupportedPtyEntry) => void) => () => void
    onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void) => () => void
    getMigrationUnsupportedSnapshot: () => Promise<MigrationUnsupportedPtyEntry[]>
    /** Drop a paneKey from the main-process hook cache and the on-disk
     *  last-status file. Fire-and-forget. */
    drop: (paneKey: string) => void
    /** Drop every cached hook status under one terminal tab prefix.
     *  Fire-and-forget. */
    dropByTabPrefix: (tabId: string) => void
    /** Permanently retire one pane's hook authority while siblings stay live. */
    retirePaneAuthority: (paneKey: string) => void
    /** Move hook authority when a live pane is detached into another tab. */
    transferPaneAuthority: (args: {
      fromPaneKey: string
      toPaneKey: string
      ptyId?: string
    }) => void
  }
  mobile: {
    listNetworkInterfaces: () => Promise<{
      interfaces: { name: string; address: string }[]
    }>
    getPairingQR: (args?: {
      address?: string
      connectionMode?: MobilePairingConnectionMode
      rotate?: boolean
    }) => Promise<
      | { available: false }
      | {
          available: true
          qrDataUrl: string
          pairingUrl: string
          endpoint: string
          deviceId: string
        }
    >
    getWindowsFirewallStatus: (args?: { address?: string }) => Promise<
      | { supported: false }
      | {
          supported: true
          port: number
          ruleAllowed: boolean
          blockingRuleDetected: boolean
          privateFirewallEnabled: boolean
          networkCategory: 'private' | 'public' | 'domain' | 'unknown'
          inspectionAvailable: boolean
        }
    >
    repairWindowsFirewall: () => Promise<
      { ok: true } | { ok: false; reason: 'cancelled' | 'failed' | 'unsupported' }
    >
    openWindowsNetworkSettings: () => Promise<boolean>
    getRuntimePairingUrl: (args?: { address?: string; rotate?: boolean }) => Promise<
      | { available: false }
      | {
          available: true
          pairingUrl: string
          webClientUrl: string | null
          endpoint: string
          deviceId: string
        }
    >
    listDevices: () => Promise<{
      devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
    }>
    revokeDevice: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
    listRuntimeAccessGrants: () => Promise<{ grants: RuntimeAccessGrant[] }>
    revokeRuntimeAccess: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
    isWebSocketReady: () => Promise<{ ready: boolean; endpoint: string | null }>
    getRelayStatus: () => Promise<{ status: MobileRelayStatus }>
    onRelayStatusChanged: (callback: (status: MobileRelayStatus) => void) => () => void
  }
  speech: {
    getCatalog: () => Promise<SpeechModelManifest[]>
    getModelStates: () => Promise<SpeechModelState[]>
    getOpenAiApiKeyStatus: () => Promise<{ configured: boolean }>
    saveOpenAiApiKey: (apiKey: string) => Promise<{ configured: boolean }>
    clearOpenAiApiKey: () => Promise<{ configured: boolean }>
    downloadModel: (modelId: string) => Promise<void>
    cancelDownload: (modelId: string) => Promise<void>
    deleteModel: (modelId: string) => Promise<void>
    startDictation: (
      modelId: string,
      hotwords: string[] | undefined,
      sessionId: string
    ) => Promise<void>
    feedAudio: (samples: Float32Array, sampleRate: number, sessionId?: string) => Promise<void>
    stopDictation: (sessionId?: string) => Promise<void>
    onPartialTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
    onFinalTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
    onDownloadProgress: (
      callback: (data: { modelId: string; progress: number }) => void
    ) => () => void
    onReady: (callback: (data: SpeechLifecycleEvent) => void) => () => void
    onStopped: (callback: (data: SpeechLifecycleEvent) => void) => () => void
    onError: (callback: (data: SpeechErrorEvent) => void) => () => void
  }
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
