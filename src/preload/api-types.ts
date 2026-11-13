import type {
  ClaudeAccountsApi,
  CodexAccountsApi,
  CodexConfigSyncApi,
  CursorAccountsApi,
  GrokAccountsApi,
  MinimaxCredentialsApi,
  ZcodePlanCredentialsApi
} from './api/agent-accounts/agent-account-api'
import type { HooksApi } from './api/agent-hooks/agent-hook-api'
import type { SkillsApi } from './api/skills/agent-skill-api'
import type { AgentAwakeApi, AgentStatusApi } from './api/agent-status/agent-status-api'
import type {
  ClaudeUsageApi,
  CodexUsageApi,
  MuseUsageApi,
  OpenCodeUsageApi,
  RateLimitsApi
} from './api/agent-usage/agent-usage-api'
import type { AiVaultApi } from './api/ai-vault/ai-vault-api'
import type { AppApi, E2EApi, PlatformApi } from './api/app-api'
import type { AutomationsApi } from './api/automations/automation-api'
import type { BrowserApi } from './api/browser/browser-api'
import type { CliApi } from './api/cli-install/cli-install-api'
import type { CrashReportsApi, FeedbackApi } from './api/diagnostics/crash-report-api'
import type { DashboardApi, TerminalPreviewApi } from './api/window-ui/dashboard-api'
import type { FloatingWorkspaceWindowApi } from './api/window-ui/floating-workspace-window-api'
import type { DocPreviewApi } from './api/document-preview/doc-preview-api'
import type { EmulatorApi } from './api/emulator/emulator-api'
import type { EphemeralVmApi } from './api/cloud-workspaces/ephemeral-vm-api'
import type { ExportApi, FilesystemApi } from './api/filesystem/filesystem-api'
import type { GitInspectionApi } from './api/source-control/git-inspection-api'
import type { GitOperationApi } from './api/source-control/git-operation-api'
import type { GithubAccountApi } from './api/github/github-account-api'
import type { GithubPullRequestApi } from './api/github/github-pull-request-api'
import type { GithubWorkItemApi } from './api/github/github-work-item-api'
import type { GitLabApi } from './api/gitlab/gitlab-api'
import type { BitbucketApi, HostedReviewApi } from './api/hosted-review/hosted-review-api'
import type { JiraApi } from './api/work-items/jira-api'
import type { LinearApi } from './api/work-items/linear-api'
import type { MobileApi } from './api/mobile/mobile-api'
import type { NativeChatApi } from './api/native-chat/native-chat-api'
import type { OnboardingApi, StarNagApi } from './api/onboarding/onboarding-api'
import type { OrcaProfileApi } from './api/profiles/orca-profile-api'
import type {
  ComputerUsePermissionsApi,
  DeveloperPermissionsApi,
  MacosTccPromptsApi,
  NotificationsApi
} from './api/desktop-permissions/os-permission-api'
import type { PetApi } from './api/pets/pet-api'
import type { AppIconApi } from './api/window-ui/app-icon-api'
import type { BrowserPasswordsApi } from './api/browser/browser-passwords-api'
import type { PluginsApi } from './api/plugins/plugin-host-api'
import type { PreflightApi } from './api/preflight/preflight-api'
import type { PtyApi } from './api/terminal/pty-api'
import type { ProjectGroupsApi, ProjectsApi, RepositoryApi } from './api/projects/repository-api'
import type { RuntimeApi } from './api/runtime/runtime-api'
import type { WslMoveApi } from './api/wsl/wsl-move-bridge'
import type { WslDriveProjectApi } from './api/wsl/wsl-drive-project-bridge'
import type { WslDriveUncConversionApi } from './api/wsl/wsl-drive-unc-conversion-bridge'
import type { KeybindingsApi, SettingsApi } from './api/preferences/settings-api'
import type { ShellApi } from './api/terminal/shell-api'
import type { SpeechApi } from './api/speech/speech-api'
import type { SshApi } from './api/ssh/ssh-api'
import type { PlainSshTerminalApi } from './api/terminal/plain-ssh-terminal-bridge'
import type { LegacyRelayBridgeApi } from './api/mobile/legacy-relay-bridge-api'
import type {
  DiagnosticsApi,
  MemoryApi,
  StatsApi,
  TelemetryApi
} from './api/diagnostics/telemetry-api'
import type { UiCommandEventApi } from './api/window-ui/ui-command-event-api'
import type { UiWindowApi } from './api/window-ui/ui-window-api'
import type { UpdaterApi } from './api/updater/updater-api'
import type { WorkspaceCleanupApi, WorkspaceSpaceApi } from './api/workspaces/workspace-cleanup-api'
import type {
  LocalhostWorktreeLabelsApi,
  WorkspacePortsApi
} from './api/workspaces/workspace-port-api'
import type { LinkPreviewApi } from './api/link-preview/link-preview-api'
import type { WorkspaceSessionApi } from './api/workspaces/workspace-session-api'
import type {
  FolderWorkspacesApi,
  SparsePresetsApi,
  WorktreeApi
} from './api/workspaces/worktree-api'

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
  linkPreview: LinkPreviewApi
  pty: PtyApi
  feedback: FeedbackApi
  crashReports: CrashReportsApi
  export: ExportApi
  gh: Merged<GithubPullRequestApi & GithubWorkItemApi & GithubAccountApi>
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
  preflight: PreflightApi
  notifications: NotificationsApi
  onboarding: OnboardingApi
  dashboard: DashboardApi
  floatingWorkspaceWindow: FloatingWorkspaceWindowApi
  terminalPreview: TerminalPreviewApi
  macosTccPrompts: MacosTccPromptsApi
  developerPermissions: DeveloperPermissionsApi
  computerUsePermissions: ComputerUsePermissionsApi
  shell: ShellApi
  skills: SkillsApi
  pet: PetApi
  appIcon: AppIconApi
  browser: BrowserApi
  browserPasswords: BrowserPasswordsApi
  emulator: EmulatorApi
  hooks: HooksApi
  ephemeralVm: EphemeralVmApi
  cache: WorkspaceSessionApi['cache']
  session: WorkspaceSessionApi['session']
  updater: UpdaterApi
  notebook: FilesystemApi['notebook']
  docPreview: DocPreviewApi['docPreview']
  stats: StatsApi
  memory: MemoryApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  openCodeUsage: OpenCodeUsageApi
  museUsage: MuseUsageApi
  aiVault: AiVaultApi
  nativeChat: NativeChatApi
  fs: FilesystemApi['fs']
  git: Merged<GitInspectionApi & GitOperationApi>
  ui: Merged<UiCommandEventApi & UiWindowApi>
  runtime: RuntimeApi['runtime']
  runtimeEnvironments: RuntimeApi['runtimeEnvironments']
  rateLimits: RateLimitsApi
  opencodeGoCredentials: {
    getStatus: () => Promise<{ apiKeyConfigured: boolean }>
    saveApiKey: (key: string) => Promise<{ apiKeyConfigured: boolean }>
    clearApiKey: () => Promise<{ apiKeyConfigured: boolean }>
  }
  minimaxCredentials: MinimaxCredentialsApi
  zcodePlanCredentials: ZcodePlanCredentialsApi
  grokAccounts: GrokAccountsApi
  cursorAccounts: CursorAccountsApi
  ssh: SshApi
  /** Desktop only: an unmanaged ssh login to a host whose move is blocked. */
  plainSsh?: PlainSshTerminalApi
  /** COMPAT(legacy-relay-bridge): desktop-only, revisit 2027-01-15. */
  legacyRelayBridge?: LegacyRelayBridgeApi
  automations: AutomationsApi
  wsl: RuntimeApi['wsl']
  wslMove: WslMoveApi
  wslDriveProject: WslDriveProjectApi
  wslDriveUnc: WslDriveUncConversionApi
  pwsh: RuntimeApi['pwsh']
  gitBash: RuntimeApi['gitBash']
  plugins: PluginsApi
  agentStatus: AgentStatusApi
  mobile: MobileApi
  speech: SpeechApi
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    api: PreloadApi
  }
}
