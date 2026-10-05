import { contextBridge, ipcRenderer } from 'electron'
import { HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL } from '../shared/hidden-window-frame-pump'
import { installHiddenWindowFramePump } from './renderer/hidden-window-frame-pump'
import type { PreloadApi } from './api-types'
import { installBrowserFindListener } from './renderer/renderer-runtime'
import { appApi } from './api/app-bridge'
import { orcaProfilesApi } from './api/profiles/orca-profiles-bridge'
import { platformApi } from './api/platform-bridge'
import { wslApi } from './api/wsl/wsl-bridge'
import { wslMoveApi } from './api/wsl/wsl-move-bridge'
import { wslDriveProjectApi } from './api/wsl/wsl-drive-project-bridge'
import { wslDriveUncConversionApi } from './api/wsl/wsl-drive-unc-conversion-bridge'
import { pwshApi } from './api/terminal/pwsh-bridge'
import { gitBashApi } from './api/terminal/git-bash-bridge'
import { pluginsApi } from './api/plugins/plugins-bridge'
import { reposApi } from './api/projects/repos-bridge'
import { projectsApi } from './api/projects/projects-bridge'
import { projectGroupsApi } from './api/projects/project-groups-bridge'
import { folderWorkspacesApi } from './api/workspaces/folder-workspaces-bridge'
import { sparsePresetsApi } from './api/source-control/sparse-presets-bridge'
import { worktreesApi } from './api/workspaces/worktrees-bridge'
import { workspaceCleanupApi } from './api/workspaces/workspace-cleanup-bridge'
import { workspaceSpaceApi } from './api/workspaces/workspace-space-bridge'
import { workspacePortsApi } from './api/workspaces/workspace-ports-bridge'
import { linkPreviewApi } from './api/link-preview/link-preview-bridge'
import { ptyApi } from './api/terminal/pty-bridge'
import { feedbackApi } from './api/diagnostics/feedback-bridge'
import { crashReportsApi } from './api/diagnostics/crash-reports-bridge'
import { exportApi } from './api/document-preview/export-bridge'
import { ghApi } from './api/github/gh-bridge'
import { hostedReviewApi } from './api/hosted-review/hosted-review-bridge'
import { glApi } from './api/gitlab/gitlab'
import { bitbucketApi } from './api/hosted-review/bitbucket-bridge'
import { linearApi } from './api/work-items/linear-bridge'
import { jiraApi } from './api/work-items/jira-bridge'
import { starNagApi } from './api/onboarding/star-nag-bridge'
import { diagnosticsApi } from './api/diagnostics/diagnostics-bridge'
import { settingsApi } from './api/preferences/settings-bridge'
import { agentAwakeApi } from './api/agent-status/agent-awake-bridge'
import { localhostWorktreeLabelsApi } from './api/workspaces/localhost-worktree-labels-bridge'
import { keybindingsApi } from './api/preferences/keybindings-bridge'
import { codexAccountsApi } from './api/agent-accounts/codex-accounts-bridge'
import { claudeAccountsApi } from './api/agent-accounts/claude-accounts-bridge'
import { cliApi } from './api/cli-install/cli-bridge'
import { codexConfigSyncApi } from './api/agent-accounts/codex-config-sync-bridge'
import { preflightApi } from './api/preflight/preflight-bridge'
import { notificationsApi } from './api/notifications/notifications-bridge'
import { onboardingApi } from './api/onboarding/onboarding-bridge'
import { dashboardApi } from './api/window-ui/dashboard-bridge'
import { terminalPreviewApi } from './api/terminal/terminal-preview-bridge'
import { macosTccPromptsApi } from './api/desktop-permissions/macos-tcc-prompts-bridge'
import { developerPermissionsApi } from './api/desktop-permissions/developer-permissions-bridge'
import { computerUsePermissionsApi } from './api/desktop-permissions/computer-use-permissions-bridge'
import { shellApi } from './api/terminal/shell-bridge'
import { skillsApi } from './api/skills/skills-bridge'
import { petApi } from './api/pets/pet-bridge'
import { appIconApi } from './api/window-ui/app-icon-bridge'
import { browserPasswordsApi } from './api/browser/browser-passwords-bridge'
import { browserApi } from './api/browser/browser-bridge'
import { emulatorApi } from './api/emulator/emulator-bridge'
import { hooksApi } from './api/agent-hooks/hooks-bridge'
import { ephemeralVmApi } from './api/cloud-workspaces/ephemeral-vm-bridge'
import { cacheApi } from './api/github/cache-bridge'
import { sessionApi } from './api/workspaces/session-bridge'
import { updaterApi } from './api/updater/updater-bridge'
import { docPreviewApi } from './api/document-preview/doc-preview-bridge'
import { notebookApi } from './api/document-preview/notebook-bridge'
import { fsApi } from './api/filesystem/fs-bridge'
import { gitApi } from './api/source-control/git-bridge'
import { uiApi } from './api/window-ui/ui-bridge'
import { statsApi } from './api/diagnostics/stats-bridge'
import { memoryApi } from './api/diagnostics/memory-bridge'
import { claudeUsageApi } from './api/agent-usage/claude-usage-bridge'
import { codexUsageApi } from './api/agent-usage/codex-usage-bridge'
import { openCodeUsageApi } from './api/agent-usage/open-code-usage-bridge'
import { museUsageApi } from './api/agent-usage/muse-usage-bridge'
import { aiVaultApi } from './api/ai-vault/ai-vault-bridge'
import { nativeChatApi } from './api/native-chat/native-chat-bridge'
import { runtimeApi } from './api/runtime/runtime-bridge'
import { runtimeEnvironmentsApi } from './api/runtime/runtime-environments-bridge'
import { rateLimitsApi } from './api/agent-usage/rate-limits-bridge'
import { opencodeGoCredentialsApi } from './api/agent-accounts/opencode-go-credentials-bridge'
import { minimaxCredentialsApi } from './api/agent-accounts/minimax-credentials-bridge'
import { zcodePlanCredentialsApi } from './api/agent-accounts/zcode-plan-credentials-bridge'
import { grokAccountsApi } from './api/agent-accounts/grok-accounts-bridge'
import { cursorAccountsApi } from './api/agent-accounts/cursor-accounts-bridge'
import { sshApi } from './api/ssh/ssh-bridge'
import { plainSshTerminalApi } from './api/terminal/plain-ssh-terminal-bridge'
import { legacyRelayBridgeApi } from './api/mobile/legacy-relay-bridge-api'
import { automationsApi } from './api/automations/automations-bridge'
import { e2eApi } from './api/diagnostics/e2e-bridge'
import { mobileApi } from './api/mobile/mobile-bridge'
import { agentStatusApi } from './api/agent-status/agent-status-bridge'
import { speechApi } from './api/speech/speech-bridge'
import { scheduledMessagesApi } from './api/scheduled-messages/scheduled-messages-bridge'

installBrowserFindListener()

const telemetryTrackApi: PreloadApi['telemetryTrack'] = (name, props) =>
  ipcRenderer.invoke('telemetry:track', name, props)
const telemetrySetOptInApi: PreloadApi['telemetrySetOptIn'] = (optedIn) =>
  ipcRenderer.invoke('telemetry:setOptIn', optedIn)
const telemetryAcknowledgeBannerApi: PreloadApi['telemetryAcknowledgeBanner'] = () =>
  ipcRenderer.invoke('telemetry:acknowledgeBanner')
const telemetryGetConsentStateApi: PreloadApi['telemetryGetConsentState'] = () =>
  ipcRenderer.invoke('telemetry:getConsentState')

const api = {
  app: appApi,
  orcaProfiles: orcaProfilesApi,
  platform: platformApi,
  wsl: wslApi,
  wslMove: wslMoveApi,
  wslDriveProject: wslDriveProjectApi,
  wslDriveUnc: wslDriveUncConversionApi,
  pwsh: pwshApi,
  gitBash: gitBashApi,
  plugins: pluginsApi,
  repos: reposApi,
  projects: projectsApi,
  projectGroups: projectGroupsApi,
  folderWorkspaces: folderWorkspacesApi,
  sparsePresets: sparsePresetsApi,
  worktrees: worktreesApi,
  workspaceCleanup: workspaceCleanupApi,
  workspaceSpace: workspaceSpaceApi,
  workspacePorts: workspacePortsApi,
  linkPreview: linkPreviewApi,
  pty: ptyApi,
  feedback: feedbackApi,
  crashReports: crashReportsApi,
  export: exportApi,
  gh: ghApi,
  hostedReview: hostedReviewApi,
  gl: glApi,
  bitbucket: bitbucketApi,
  linear: linearApi,
  jira: jiraApi,
  starNag: starNagApi,
  telemetryTrack: telemetryTrackApi,
  telemetrySetOptIn: telemetrySetOptInApi,
  telemetryAcknowledgeBanner: telemetryAcknowledgeBannerApi,
  telemetryGetConsentState: telemetryGetConsentStateApi,
  diagnostics: diagnosticsApi,
  settings: settingsApi,
  agentAwake: agentAwakeApi,
  localhostWorktreeLabels: localhostWorktreeLabelsApi,
  keybindings: keybindingsApi,
  codexAccounts: codexAccountsApi,
  claudeAccounts: claudeAccountsApi,
  cli: cliApi,
  codexConfigSync: codexConfigSyncApi,
  preflight: preflightApi,
  notifications: notificationsApi,
  onboarding: onboardingApi,
  dashboard: dashboardApi,
  terminalPreview: terminalPreviewApi,
  macosTccPrompts: macosTccPromptsApi,
  developerPermissions: developerPermissionsApi,
  computerUsePermissions: computerUsePermissionsApi,
  shell: shellApi,
  skills: skillsApi,
  pet: petApi,
  appIcon: appIconApi,
  browser: browserApi,
  browserPasswords: browserPasswordsApi,
  emulator: emulatorApi,
  hooks: hooksApi,
  ephemeralVm: ephemeralVmApi,
  cache: cacheApi,
  session: sessionApi,
  updater: updaterApi,
  docPreview: docPreviewApi,
  notebook: notebookApi,
  fs: fsApi,
  git: gitApi,
  ui: uiApi,
  stats: statsApi,
  memory: memoryApi,
  claudeUsage: claudeUsageApi,
  codexUsage: codexUsageApi,
  openCodeUsage: openCodeUsageApi,
  museUsage: museUsageApi,
  aiVault: aiVaultApi,
  nativeChat: nativeChatApi,
  runtime: runtimeApi,
  runtimeEnvironments: runtimeEnvironmentsApi,
  rateLimits: rateLimitsApi,
  opencodeGoCredentials: opencodeGoCredentialsApi,
  scheduledMessages: scheduledMessagesApi,
  minimaxCredentials: minimaxCredentialsApi,
  zcodePlanCredentials: zcodePlanCredentialsApi,
  grokAccounts: grokAccountsApi,
  cursorAccounts: cursorAccountsApi,
  ssh: sshApi,
  plainSsh: plainSshTerminalApi,
  legacyRelayBridge: legacyRelayBridgeApi,
  automations: automationsApi,
  e2e: e2eApi,
  mobile: mobileApi,
  agentStatus: agentStatusApi,
  speech: speechApi
} satisfies PreloadApi

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.api = api
}

installHiddenWindowFramePump(
  process.argv,
  (stop) => ipcRenderer.once(HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL, stop),
  {
    rootStyle: () => document.documentElement?.style ?? null,
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    every: (callback, ms) => {
      const handle = window.setInterval(callback, ms)
      return () => window.clearInterval(handle)
    }
  }
)
