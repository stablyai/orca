import { app } from 'electron'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { registerAppHandlers } from '../app'
import { registerCliHandlers } from '../cli'
import { registerPreflightHandlers } from '../preflight'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerFilesystemHandlers } from '../filesystem/filesystem'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/commit-message-agent-environment'
import { registerFilesystemWatcherHandlers } from '../filesystem/watchers/filesystem-watcher-handlers'
import { registerUsageProviderHandlers } from '../usage-provider-handlers'
import { registerGitHubHandlers } from '../github'
import { registerGitLabHandlers } from '../gitlab'
import { registerHostedReviewHandlers } from '../hosted-review'
import { registerLinearHandlers } from '../linear/register-handlers'
import { registerJiraHandlers } from '../jira/register-handlers'
import { registerJiraIssueSummaryGenerationHandlers } from '../jira/issue-summary-generation'
import { registerBitbucketHandlers } from '../bitbucket'
import { registerFeedbackHandlers } from '../feedback'
import { registerCrashReportingHandlers } from '../crash-reporting'
import { registerExportHandlers } from '../export'
import { registerStatsHandlers } from '../stats'
import { registerMemoryHandlers } from '../memory'
import { registerRateLimitHandlers } from '../rate-limits'
import { registerRuntimeHandlers } from '../runtime'
import {
  invalidateRuntimeEnvironmentTransport,
  registerRuntimeEnvironmentHandlers
} from '../runtime-environments/runtime-environments'
import { registerWslHostHandlers } from '../wsl-host-handlers'
import { registerWslMoveHandlers } from '../wsl-move-handlers'
import { registerEphemeralVmHandlers } from '../ephemeral-vm'
import { registerAiVaultHandlers } from '../ai-vault'
import { registerAiVaultSearchHandlers } from '../ai-vault-search'
import { registerNativeChatHandlers } from '../native-chat'
import { registerNotificationHandlers } from '../notifications'
import { registerNotebookHandlers } from '../notebook'
import { registerOnboardingHandlers } from '../onboarding'
import { registerDashboardPopoutHandlers } from '../dashboard-popout'
import { registerWorkspaceSpaceWindowHandlers } from '../workspace-space-window'
import { registerTerminalPreviewHandlers } from '../terminal-preview'
import { registerDeveloperPermissionHandlers } from '../developer-permissions'
import { registerComputerUsePermissionHandlers } from '../computer-use-permissions'
import { setAgentBrowserBridgeRef, registerBrowserHandlers } from '../browser'
import { setTrustedBrowserRendererWebContentsId } from '../browser-renderer-trust'
import { registerSessionHandlers } from '../session'
import { registerSettingsHandlers } from '../settings'
import { registerDiagnosticsHandlers } from '../diagnostics'
import { registerSkillsHandlers } from '../skills'
import { registerSkillDeleteIpcHandlers } from '../skill-delete/handlers'
import { registerWorkspaceSpaceHandlers } from '../workspace-space'
import { registerWorkspacePortHandlers } from '../workspace-ports'
import { registerLocalhostWorktreeLabelHandlers } from '../localhost-worktree-labels'
import { registerAutomationHandlers } from '../automations'
import { registerKeybindingHandlers } from '../keybindings'
import { registerTelemetryHandlers } from '../telemetry'
import { registerShellHandlers } from '../shell'
import { registerPetHandlers } from '../pet'
import { registerPluginHandlers } from '../plugins'
import { registerUIHandlers, setTrustedUIRendererWebContentsId } from '../ui'
import { registerEmulatorFrameStreamHandlers } from '../emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from '../emulator-video-stream'
import { registerSpeechHandlers } from '../speech'
import { registerTerminalRenderDesyncEvidenceHandler } from '../terminal-render-desync-evidence'
import { registerOrcaProfileHandlers } from '../orca-profiles'
import { registerCodexAccountHandlers } from '../codex-accounts'
import { registerAgentHookHandlers } from '../agent-hooks'
import { registerCodexConfigSyncHandlers } from '../codex-config-sync'
import { getPtyIdForPaneKey } from '../pty/pane/key-state'
import { registerClaudeAccountHandlers } from '../claude-accounts'
import { registerOpenCodeGoCredentialsHandlers } from '../opencode-go-credentials'
import { registerMiniMaxCredentialsHandlers } from '../minimax-credentials'
import { registerZcodePlanCredentialsHandlers } from '../zcode-plan-credentials'
import { registerGrokAccountHandlers } from '../grok-accounts'
import { registerCursorAccountHandlers } from '../cursor-accounts'
import { registerUpdaterHandlers } from '../../window/attach-main-window-services'
import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from '../../window/clipboard-ipc-handlers'
import { isDashboardPopoutRenderer } from '../../window/dashboard-popout-window'
import type { ClaudeUsageStore } from '../../claude-usage/store'
import type { CodexUsageStore } from '../../codex-usage/store'
import type { OpenCodeUsageStore } from '../../opencode-usage/store'
import type { MuseUsageStore } from '../../muse-usage/store'
import type { RateLimitService } from '../../rate-limits/service'
import type { CodexAccountService } from '../../codex-accounts/service'
import type { ClaudeAccountService } from '../../claude-accounts/service'
import type { AutomationService } from '../../automations/service'
import type { AgentAwakeService } from '../../agent-awake-service'
import type { CrashReportStore } from '../../crash-reporting/crash-report-store'
import type { KeybindingService } from '../../keybindings/keybinding-service'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault-resume-preparation'
import {
  getSavedRuntimeAiVaultHostInfos,
  prepareRuntimeAiVaultSessionResume,
  resolveRuntimeAiVaultSessionTitles,
  scanRuntimeAiVaultSessions
} from '../../ai-vault/runtime-session-scanner'
import { callRuntimeSessionSearch } from '../../ai-vault/runtime-session-search-call'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../../runtime/structured-agent-session-host-refusal'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { PluginService } from '../../plugins/plugin-service'
import type { PluginMarketplaceHandlerServices } from '../plugin-marketplaces'
import { settleWithinMs } from '../../quit-teardown-deadline'

let registered = false
// Same cap as the restart path's auth preservation: bookkeeping must not hold Restart on a stalled disk.
const RELAUNCH_DISMISSAL_CLOSE_TIMEOUT_MS = 2_000

async function closeNotificationDismissalsBeforeRelaunch(
  runtime: OrcaRuntimeService
): Promise<void> {
  const result = await settleWithinMs(
    runtime.closeNotificationDismissals(),
    RELAUNCH_DISMISSAL_CLOSE_TIMEOUT_MS
  )
  if (result.outcome === 'timed-out') {
    console.warn('[notifications] Relaunching before dismissal recovery state finished saving')
  }
}

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
  museUsage: MuseUsageStore,
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
  // macOS activation can replace the window without ending the app; refresh trusted IDs but register IPC once.
  setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId)
  setTrustedClipboardRendererWebContentsId(mainWindowWebContentsId)
  setTrustedUIRendererWebContentsId(mainWindowWebContentsId)
  setAgentBrowserBridgeRef(runtime.getAgentBrowserBridge())
  if (registered) {
    return
  }
  registered = true

  registerAppHandlers(store, {
    quitResumeRecordsFor: (session) => runtime.quitResumeRecordsFor(session),
    ...(ORCA_LAYOUT_OWNER_IS_MAIN
      ? {
          reconnectFactsFor: (session, partition) =>
            runtime.shutdownReconnectFactsFor(session, partition)
        }
      : {}),
    onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch,
    // Restart/profile switching closes this through will-quit; this callback covers relaunch exit.
    onBeforeRelaunchExit: () => closeNotificationDismissalsBeforeRelaunch(runtime)
  })
  registerCliHandlers()
  registerPreflightHandlers()
  registerUsageProviderHandlers({ claudeUsage, codexUsage, openCodeUsage, museUsage })
  registerCodexAccountHandlers(codexAccounts, () => store.getSettings())
  registerAgentHookHandlers(runtime, { getPtyIdForPaneKey })
  registerCodexConfigSyncHandlers(codexAccounts.runtimeHomeService)
  registerClaudeAccountHandlers(claudeAccounts)
  registerOpenCodeGoCredentialsHandlers(rateLimits)
  registerMiniMaxCredentialsHandlers(rateLimits)
  registerZcodePlanCredentialsHandlers(rateLimits)
  registerGrokAccountHandlers()
  registerCursorAccountHandlers()
  registerRateLimitHandlers(rateLimits, codexAccounts)
  registerGitHubHandlers(store, stats)
  registerGitLabHandlers(store)
  registerHostedReviewHandlers(store, stats)
  registerLinearHandlers()
  registerJiraHandlers()
  registerJiraIssueSummaryGenerationHandlers(store, commitMessageAgentEnv)
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
  registerWorkspaceSpaceWindowHandlers(store)
  registerTerminalPreviewHandlers(runtime)
  registerDeveloperPermissionHandlers()
  // Diagnostics and telemetry register independent channels and keep separate data paths.
  registerDiagnosticsHandlers()
  registerTerminalRenderDesyncEvidenceHandler()
  registerComputerUsePermissionHandlers()
  registerSettingsHandlers(store, agentAwakeService)
  registerSkillsHandlers(store, runtime)
  registerSkillDeleteIpcHandlers(store, runtime)
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
  registerSessionHandlers(store, runtime)
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
  registerWslHostHandlers({
    store,
    getUserDataPath: () => app.getPath('userData'),
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerWslMoveHandlers(() => app.getPath('userData'))
  registerEphemeralVmHandlers(store, pluginService)
  // Session history and terminal resume are not chats; a refused host leaves nothing to check.
  const ensureStructuredSessionOwnership = () =>
    ensureStructuredAgentSessionHostUnlessRefused(() => runtime.ensureStructuredAgentSessionHost())
  registerAiVaultSearchHandlers({
    callRuntimeSearch: (environmentId, method, params) =>
      callRuntimeSessionSearch(app.getPath('userData'), environmentId, method, params),
    ensureStructuredSessionOwnership
  })
  registerAiVaultHandlers({
    ensureStructuredSessionOwnership,
    getAdditionalCodexHomePaths: lifecycleOptions.getAdditionalAiVaultCodexHomePaths,
    prepareSessionResume: lifecycleOptions.prepareAiVaultSessionResume,
    getActiveRuntimeAiVaultHostInfos: () =>
      getSavedRuntimeAiVaultHostInfos(app.getPath('userData')),
    scanRuntimeAiVaultSessions: async (environmentId, args, options) =>
      scanRuntimeAiVaultSessions(app.getPath('userData'), environmentId, args, options),
    resolveRuntimeAiVaultSessionTitles: async (environmentId, args) =>
      resolveRuntimeAiVaultSessionTitles(app.getPath('userData'), environmentId, args),
    prepareRuntimeSessionResume: async (environmentId, args) =>
      prepareRuntimeAiVaultSessionResume(app.getPath('userData'), environmentId, args)
  })
  registerNativeChatHandlers()
  registerClipboardHandlers(store, {
    localChatAttachmentStore: async () => {
      await ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
      return getAgentSessionAttachmentStore()
    }
  })
  registerUpdaterHandlers(store)
  registerSpeechHandlers(store)
}
