import { app } from 'electron'
import { registerAppHandlers } from './app'
import { registerCliHandlers } from './cli'
import { registerPreflightHandlers } from './preflight'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StatsCollector } from '../stats/collector'
import { registerFilesystemHandlers } from './filesystem'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { registerUsageProviderHandlers } from './usage-provider-handlers'
import { registerGitHubHandlers } from './github'
import { registerGitLabHandlers } from './gitlab'
import { registerHostedReviewHandlers } from './hosted-review'
import { registerLinearHandlers } from './linear'
import { registerJiraHandlers } from './jira'
import { registerBitbucketHandlers } from './bitbucket'
import { registerFeedbackHandlers } from './feedback'
import { registerCrashReportingHandlers } from './crash-reporting'
import { registerExportHandlers } from './export'
import { registerStatsHandlers } from './stats'
import { registerMemoryHandlers } from './memory'
import { registerRateLimitHandlers } from './rate-limits'
import { registerRuntimeHandlers } from './runtime'
import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
import { registerEphemeralVmHandlers } from './ephemeral-vm'
import { registerAiVaultHandlers } from './ai-vault'
import { registerNativeChatHandlers } from './native-chat'
import { registerNotificationHandlers } from './notifications'
import { registerNotebookHandlers } from './notebook'
import { registerOnboardingHandlers } from './onboarding'
import { registerDashboardPopoutHandlers } from './dashboard-popout'
import { registerTerminalPreviewHandlers } from './terminal-preview'
import { registerDeveloperPermissionHandlers } from './developer-permissions'
import { registerComputerUsePermissionHandlers } from './computer-use-permissions'
import { setAgentBrowserBridgeRef, registerBrowserHandlers } from './browser'
import { setTrustedBrowserRendererWebContentsId } from './browser-renderer-trust'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerAgentCatalogHandlers } from './agent-catalog'
import { registerDataRecoveryHandlers } from './data-recovery'
import { registerDiagnosticsHandlers } from './diagnostics'
import { registerSkillsHandlers } from './skills'
import { registerWorkspaceSpaceHandlers } from './workspace-space'
import { registerWorkspacePortHandlers } from './workspace-ports'
import { registerLocalhostWorktreeLabelHandlers } from './localhost-worktree-labels'
import { registerAutomationHandlers } from './automations'
import { registerKeybindingHandlers } from './keybindings'
import { registerTelemetryHandlers } from './telemetry'
import { registerShellHandlers } from './shell'
import { registerPetHandlers } from './pet'
import { registerPluginHandlers } from './plugins'
import { registerUIHandlers, setTrustedUIRendererWebContentsId } from './ui'
import { registerEmulatorFrameStreamHandlers } from './emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from './emulator-video-stream'
import { registerSpeechHandlers } from './speech'
import { registerTerminalRenderDesyncEvidenceHandler } from './terminal-render-desync-evidence'
import { registerOrcaProfileHandlers } from './orca-profiles'
import { registerCodexAccountHandlers } from './codex-accounts'
import { registerAgentHookHandlers } from './agent-hooks'
import { registerCodexConfigSyncHandlers } from './codex-config-sync'
import { getPtyIdForPaneKey } from './pty'
import { registerAgentTrustHandlers } from './agent-trust'
import { registerClaudeAccountHandlers } from './claude-accounts'
import { registerMiniMaxCredentialsHandlers } from './minimax-credentials'
import { registerGrokAccountHandlers } from './grok-accounts'
import { registerUpdaterHandlers } from '../window/attach-main-window-services'
import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from '../window/clipboard-ipc-handlers'
import { isDashboardPopoutRenderer } from '../window/dashboard-popout-window'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { AutomationService } from '../automations/service'
import type { AgentAwakeService } from '../agent-awake-service'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import {
  getSavedRuntimeAiVaultHostInfos,
  prepareRuntimeAiVaultSessionResume,
  resolveRuntimeAiVaultResumeDetails,
  resolveRuntimeAiVaultSessionTitles,
  scanRuntimeAiVaultSessions
} from '../ai-vault/runtime-session-scanner'
import type { PluginService } from '../plugins/plugin-service'
import type { PluginMarketplaceHandlerServices } from './plugin-marketplaces'

let registered = false

type CoreHandlerLifecycleOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onOrcaProfileAuthMutation?: () => void
  onBeforeOrcaProfileSignOut?: () => void
  getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
  prepareAiVaultSessionResume?: (
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
}

export function registerCoreHandlers(
  store: Store,
  runtime: OrcaRuntimeService,
  stats: StatsCollector,
  claudeUsage: ClaudeUsageStore,
  codexUsage: CodexUsageStore,
  openCodeUsage: OpenCodeUsageStore,
  codexAccounts: CodexAccountService,
  claudeAccounts: ClaudeAccountService,
  rateLimits: RateLimitService,
  mainWindowWebContentsId: number | null = null,
  automations?: AutomationService,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers,
  agentAwakeService?: AgentAwakeService,
  crashReports?: CrashReportStore,
  keybindings?: KeybindingService,
  lifecycleOptions: CoreHandlerLifecycleOptions = {},
  pluginService?: PluginService,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  // Why: on macOS the app can stay alive after all windows close, then
  // openMainWindow() is called again on 'activate'. ipcMain.handle() throws
  // if a channel is registered twice, so we guard to register only once and
  // just update the per-window web-contents ID on subsequent calls.
  setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId)
  setTrustedClipboardRendererWebContentsId(mainWindowWebContentsId)
  setTrustedUIRendererWebContentsId(mainWindowWebContentsId)
  setAgentBrowserBridgeRef(runtime.getAgentBrowserBridge())
  if (registered) {
    return
  }
  registered = true

  registerAppHandlers(store, { onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch })
  registerCliHandlers()
  registerPreflightHandlers()
  registerUsageProviderHandlers({ claudeUsage, codexUsage, openCodeUsage })
  registerCodexAccountHandlers(codexAccounts, () => store.getSettings())
  registerAgentHookHandlers(runtime, { getPtyIdForPaneKey })
  registerCodexConfigSyncHandlers(codexAccounts.runtimeHomeService)
  registerAgentTrustHandlers()
  registerClaudeAccountHandlers(claudeAccounts)
  registerMiniMaxCredentialsHandlers(rateLimits)
  registerGrokAccountHandlers()
  registerRateLimitHandlers(rateLimits, codexAccounts)
  registerGitHubHandlers(store, stats)
  registerGitLabHandlers(store)
  registerHostedReviewHandlers(store, stats)
  registerLinearHandlers()
  registerJiraHandlers()
  registerBitbucketHandlers()
  registerFeedbackHandlers()
  if (crashReports) {
    registerCrashReportingHandlers(crashReports)
  }
  registerExportHandlers()
  registerStatsHandlers(stats)
  registerMemoryHandlers(store)
  registerNotificationHandlers(store, runtime)
  registerNotebookHandlers(store)
  registerOnboardingHandlers(store)
  registerDashboardPopoutHandlers(store, keybindings)
  registerTerminalPreviewHandlers(runtime)
  registerDeveloperPermissionHandlers()
  // Why: diagnostics handlers are wired alongside telemetry but the two
  // lanes never share a code path — `ipc/diagnostics.ts` imports only from
  // `src/main/observability/`, never from `src/main/telemetry/`. Order is
  // not load-bearing; both register independent ipcMain channels.
  registerDiagnosticsHandlers()
  registerTerminalRenderDesyncEvidenceHandler()
  registerComputerUsePermissionHandlers()
  registerSettingsHandlers(store, agentAwakeService)
  registerAgentCatalogHandlers(store)
  registerSkillsHandlers(store, runtime)
  registerDataRecoveryHandlers(store)
  if (automations) {
    registerAutomationHandlers(store, automations)
  }
  if (keybindings) {
    registerKeybindingHandlers(keybindings, () => {
      void pluginService?.reconcileActivationState()
    })
  }
  if (pluginService) {
    registerPluginHandlers(store, pluginService, runtime, marketplaceServices)
  }
  registerTelemetryHandlers(store)
  registerOrcaProfileHandlers(store, {
    onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch,
    onAuthMutation: lifecycleOptions.onOrcaProfileAuthMutation,
    onBeforeSignOut: lifecycleOptions.onBeforeOrcaProfileSignOut
  })
  registerBrowserHandlers()
  registerShellHandlers(store)
  registerPetHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store, { isDashboardPopoutRenderer })
  registerEmulatorFrameStreamHandlers()
  registerEmulatorVideoStreamHandlers()
  registerWorkspaceSpaceHandlers(store)
  registerWorkspacePortHandlers(store)
  registerLocalhostWorktreeLabelHandlers(store)
  if (commitMessageAgentEnv) {
    registerFilesystemHandlers(store, commitMessageAgentEnv)
  } else {
    registerFilesystemHandlers(store)
  }
  registerFilesystemWatcherHandlers()
  registerRuntimeHandlers(runtime)
  registerRuntimeEnvironmentHandlers(store)
  registerEphemeralVmHandlers(store, pluginService)
  registerAiVaultHandlers({
    getAdditionalCodexHomePaths: lifecycleOptions.getAdditionalAiVaultCodexHomePaths,
    prepareSessionResume: lifecycleOptions.prepareAiVaultSessionResume,
    getActiveRuntimeAiVaultHostInfos: () =>
      getSavedRuntimeAiVaultHostInfos(app.getPath('userData')),
    scanRuntimeAiVaultSessions: async (environmentId, args, options) =>
      scanRuntimeAiVaultSessions(app.getPath('userData'), environmentId, args, options),
    resolveRuntimeAiVaultSessionTitles: async (environmentId, args) =>
      resolveRuntimeAiVaultSessionTitles(app.getPath('userData'), environmentId, args),
    prepareRuntimeSessionResume: async (environmentId, args) =>
      prepareRuntimeAiVaultSessionResume(app.getPath('userData'), environmentId, args),
    // Without this every runtime-hosted row reports 'unavailable'; the runtime
    // must re-scan to derive its own transcript path.
    resolveRuntimeAiVaultResumeDetails: async (environmentId, entry) =>
      resolveRuntimeAiVaultResumeDetails(app.getPath('userData'), environmentId, entry),
    // Read per-call: settings change while the handlers stay registered.
    getVaultResumeSettings: () => {
      const settings = store.getSettings()
      return {
        agentCmdOverrides: settings.agentCmdOverrides,
        agentDefaultArgs: settings.agentDefaultArgs,
        agentDefaultEnv: settings.agentDefaultEnv,
        terminalWindowsShell: settings.terminalWindowsShell
      }
    }
  })
  registerNativeChatHandlers()
  registerClipboardHandlers(store)
  registerUpdaterHandlers(store)
  registerSpeechHandlers(store)
}
