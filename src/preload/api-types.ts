import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ClaudeAccountsApi,
  CodexAccountsApi,
  CodexConfigSyncApi,
  GrokAccountsApi,
  MinimaxCredentialsApi
} from './api/agent-account-api'
import type { AgentHooksApi, HooksApi } from './api/agent-hook-api'
import type { SkillsApi } from './api/agent-skill-api'
import type { AgentAwakeApi, AgentStatusApi, AgentTrustApi } from './api/agent-status-api'
import type {
  ClaudeUsageApi,
  CodexUsageApi,
  OpenCodeUsageApi,
  RateLimitsApi
} from './api/agent-usage-api'
import type { AiVaultApi } from './api/ai-vault-api'
import type { AppApi, E2EApi, PlatformApi } from './api/app-api'
import type { AutomationsApi } from './api/automation-api'
import type { BrowserApi } from './api/browser-api'
import type { CliApi } from './api/cli-install-api'
import type { CrashReportsApi, FeedbackApi } from './api/crash-report-api'
import type { DashboardApi, TerminalPreviewApi } from './api/dashboard-api'
import type { EmulatorApi } from './api/emulator-api'
import type { EphemeralVmApi } from './api/ephemeral-vm-api'
import type { ExportApi, FilesystemApi } from './api/filesystem-api'
import type { GitInspectionApi } from './api/git-inspection-api'
import type { GitOperationApi } from './api/git-operation-api'
import type { GithubPullRequestApi } from './api/github-pull-request-api'
import type { GithubWorkItemApi } from './api/github-work-item-api'
import type { GitLabApi } from './api/gitlab-api'
import type { BitbucketApi, HostedReviewApi } from './api/hosted-review-api'
import type { JiraApi } from './api/jira-api'
import type { LinearApi } from './api/linear-api'
import type { MobileApi } from './api/mobile-api'
import type { NativeChatApi } from './api/native-chat-api'
import type { OnboardingApi, StarNagApi } from './api/onboarding-api'
import type { OrcaProfileApi } from './api/orca-profile-api'
import type {
  ComputerUsePermissionsApi,
  DeveloperPermissionsApi,
  MacosTccPromptsApi,
  NotificationsApi
} from './api/os-permission-api'
import type { PetApi } from './api/pet-api'
import type { PluginsApi } from './api/plugin-host-api'
import type { PreflightApi } from './api/preflight-api'
import type { PtyApi } from './api/pty-api'
import type { ProjectGroupsApi, ProjectsApi, RepositoryApi } from './api/repository-api'
import type { RuntimeApi } from './api/runtime-api'
import type { KeybindingsApi, SettingsApi } from './api/settings-api'
import type { ShellApi } from './api/shell-api'
import type { SpeechApi } from './api/speech-api'
import type { SshApi } from './api/ssh-api'
import type { DiagnosticsApi, MemoryApi, StatsApi, TelemetryApi } from './api/telemetry-api'
import type { UiCommandEventApi } from './api/ui-command-event-api'
import type { UiWindowApi } from './api/ui-window-api'
import type { UpdaterApi } from './api/updater-api'
import type { WorkspaceCleanupApi, WorkspaceSpaceApi } from './api/workspace-cleanup-api'
import type { LocalhostWorktreeLabelsApi, WorkspacePortsApi } from './api/workspace-port-api'
import type { WorkspaceSessionApi } from './api/workspace-session-api'
import type { FolderWorkspacesApi, SparsePresetsApi, WorktreeApi } from './api/worktree-api'

// Flattens contracts that share one PreloadApi key: an intersection is not type-identical to the flat shape.
type Merged<T> = { [K in keyof T]: T[K] }

export type PreloadApi = {
  app: AppApi
  orcaProfiles: OrcaProfileApi
  platform: PlatformApi
  e2e: E2EApi
  repos: RepositoryApi
  projects: ProjectsApi
  projectGroups: ProjectGroupsApi
  folderWorkspaces: FolderWorkspacesApi
  sparsePresets: SparsePresetsApi
  worktrees: WorktreeApi
  workspaceCleanup: WorkspaceCleanupApi
  workspaceSpace: WorkspaceSpaceApi
  workspacePorts: WorkspacePortsApi
  pty: PtyApi
  feedback: FeedbackApi
  crashReports: CrashReportsApi
  export: ExportApi
  gh: Merged<GithubPullRequestApi & GithubWorkItemApi>
  hostedReview: HostedReviewApi
  gl: GitLabApi
  bitbucket: BitbucketApi
  linear: LinearApi
  jira: JiraApi
  starNag: StarNagApi
  telemetryTrack: TelemetryApi['telemetryTrack']
  telemetrySetOptIn: TelemetryApi['telemetrySetOptIn']
  diagnostics: DiagnosticsApi
  telemetryGetConsentState: TelemetryApi['telemetryGetConsentState']
  telemetryAcknowledgeBanner: TelemetryApi['telemetryAcknowledgeBanner']
  settings: SettingsApi
  agentAwake: AgentAwakeApi
  localhostWorktreeLabels: LocalhostWorktreeLabelsApi
  keybindings: KeybindingsApi
  codexAccounts: CodexAccountsApi
  claudeAccounts: ClaudeAccountsApi
  cli: CliApi
  codexConfigSync: CodexConfigSyncApi
  agentHooks: AgentHooksApi
  agentTrust: AgentTrustApi
  preflight: PreflightApi
  notifications: NotificationsApi
  onboarding: OnboardingApi
  dashboard: DashboardApi
  terminalPreview: TerminalPreviewApi
  macosTccPrompts: MacosTccPromptsApi
  developerPermissions: DeveloperPermissionsApi
  computerUsePermissions: ComputerUsePermissionsApi
  shell: ShellApi
  skills: SkillsApi
  pet: PetApi
  browser: BrowserApi
  emulator: EmulatorApi
  hooks: HooksApi
  ephemeralVm: EphemeralVmApi
  cache: WorkspaceSessionApi['cache']
  session: WorkspaceSessionApi['session']
  remoteWorkspace: WorkspaceSessionApi['remoteWorkspace']
  updater: UpdaterApi
  notebook: FilesystemApi['notebook']
  stats: StatsApi
  memory: MemoryApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  openCodeUsage: OpenCodeUsageApi
  aiVault: AiVaultApi
  nativeChat: NativeChatApi
  fs: FilesystemApi['fs']
  git: Merged<GitInspectionApi & GitOperationApi>
  ui: Merged<UiCommandEventApi & UiWindowApi>
  runtime: RuntimeApi['runtime']
  runtimeEnvironments: RuntimeApi['runtimeEnvironments']
  rateLimits: RateLimitsApi
  minimaxCredentials: MinimaxCredentialsApi
  grokAccounts: GrokAccountsApi
  ssh: SshApi
  automations: AutomationsApi
  wsl: RuntimeApi['wsl']
  pwsh: RuntimeApi['pwsh']
  gitBash: RuntimeApi['gitBash']
  plugins: PluginsApi
  agentStatus: AgentStatusApi
  mobile: MobileApi
  speech: SpeechApi
}

export type { ClaudeUsageApi, CodexUsageApi, OpenCodeUsageApi } from './api/agent-usage-api'
export type { AiVaultApi } from './api/ai-vault-api'
export type { AppApi } from './api/app-api'
export type { BrowserApi, DetectedBrowserInfo, DetectedBrowserProfileInfo } from './api/browser-api'
export type { EmulatorApi } from './api/emulator-api'
export type { ExportApi } from './api/filesystem-api'
export type {
  NativeChatApi,
  NativeChatAppendedMessages,
  NativeChatAppendedPayload,
  NativeChatReadSessionResult,
  NativeChatSubscribeArgs,
  NativeChatSubscriptionFrame
} from './api/native-chat-api'
export type {
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  PluginHostPanel,
  PluginHostStatus,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from './api/plugin-host-api'
export type {
  PreflightApi,
  PreflightRuntimeContext,
  PreflightStatus,
  RefreshAgentsResult
} from './api/preflight-api'
export type {
  PtyManagementApi,
  PtyManagementMacTccAttributionHealth,
  PtyManagementSession
} from './api/pty-management-api'
export type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from './api/shell-api'
export type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload,
  DiagnosticsUploadPayload,
  MemoryApi,
  StatsApi
} from './api/telemetry-api'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
