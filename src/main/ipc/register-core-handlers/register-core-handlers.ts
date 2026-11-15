import { app } from 'electron'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { registerAppHandlers } from '../app'
import { registerWslMoveWiring } from '../wsl/wsl-move-driver-wiring'
import { registerWslDriveProjectHandlers } from '../wsl/wsl-drive-project-handlers'
import { installProjectRuntimeGitRouter } from '../../workspaces/execution-host/project-runtime-git-router'
import { registerCliHandlers } from '../cli'
import { registerPreflightHandlers } from '../preflight'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerFilesystemHandlers } from '../filesystem/filesystem'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import { registerFilesystemWatcherHandlers } from '../filesystem/watchers/filesystem-watcher-handlers'
import { registerGitHubHandlers } from '../source-control/github'
import { registerGitLabHandlers } from '../source-control/gitlab'
import { registerHostedReviewHandlers } from '../source-control/hosted-review'
import { registerLinearHandlers } from '../linear/register-handlers'
import { registerJiraHandlers } from '../jira/register-handlers'
import { registerJiraIssueSummaryGenerationHandlers } from '../jira/issue-summary-generation'
import { registerBitbucketHandlers } from '../source-control/bitbucket'
import { registerFeedbackHandlers } from '../feedback'
import { registerCrashReportingHandlers } from '../crash-reporting/crash-reporting'
import { registerExportHandlers } from '../export'
import { registerStatsHandlers } from '../stats'
import { registerMemoryHandlers } from '../memory'
import { registerRateLimitHandlers } from '../rate-limits'
import { registerRuntimeHandlers } from '../runtime'
import { registerRuntimeHostHandlers } from './runtime-host-handler-registration'
import { registerEphemeralVmHandlers } from '../ephemeral-vm'
import { registerAiVaultHandlers } from '../ai-vault/ai-vault'
import { registerAiVaultSearchHandlers } from '../ai-vault/ai-vault-search'
import { registerNativeChatHandlers } from '../native-chat'
import { registerNotificationHandlers } from '../notifications'
import { registerNotebookHandlers } from '../notebook'
import { registerOnboardingHandlers } from '../onboarding'
import { registerDashboardPopoutHandlers } from '../dashboard-popout'
import { registerWorkspaceSpaceWindowHandlers } from '../workspace-space/workspace-space-window'
import { registerTerminalPreviewHandlers } from '../terminal-preview'
import { registerDeveloperPermissionHandlers } from '../developer-permissions'
import { registerComputerUsePermissionHandlers } from '../computer-use-permissions'
import { setAgentBrowserBridgeRef, registerBrowserHandlers } from '../browser/browser'
import { setTrustedBrowserRendererWebContentsId } from '../browser/browser-renderer-trust'
import { registerSessionHandlers } from '../session'
import { registerSettingsHandlers } from '../settings'
import { registerDiagnosticsHandlers } from '../diagnostics'
import { registerSkillsHandlers } from '../skills'
import { registerSkillDeleteIpcHandlers } from '../skill-delete/handlers'
import { registerWorkspaceSpaceHandlers } from '../workspace-space/workspace-space'
import { registerWorkspacePortHandlers } from '../workspace-ports'
import { registerLinkPreviewHandlers } from '../link-preview'
import { registerLocalhostWorktreeLabelHandlers } from '../localhost-worktree-labels'
import { registerAutomationHandlers } from '../automations'
import { registerKeybindingHandlers } from '../keybindings'
import { registerTelemetryHandlers } from '../telemetry'
import { registerShellHandlers } from '../shell'
import { registerPetHandlers } from '../pets/pet'
import { registerPluginHandlers } from '../plugins'
import { registerUIHandlers, setTrustedUIRendererWebContentsId } from '../ui'
import { registerEmulatorFrameStreamHandlers } from '../emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from '../emulator-video-stream'
import { registerEmulatorScrcpyTouchHandler } from '../emulator-scrcpy-touch'
import { registerEmulatorScrcpyKeyboardHandler } from '../emulator-scrcpy-keyboard'
import { registerSpeechHandlers } from '../speech'
import { registerTerminalRenderDesyncEvidenceHandler } from '../terminal-render-desync-evidence'
import { registerOrcaProfileHandlers } from '../profiles/orca-profiles'
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
import { registerUpdaterHandlers } from '../../updater/lifecycle/main-window-updater'
import { registerClipboardHandlers } from '../../window/clipboard/clipboard-ipc-handlers'
import { setTrustedClipboardRendererWebContentsId } from '../../window/clipboard/clipboard-ipc-sender-trust'
import { isDashboardPopoutRenderer } from '../../window/dashboard-popout-window'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import type { CodexAccountService } from '../../codex-accounts/service'
import type { ClaudeAccountService } from '../../claude-accounts/service'
import type { AutomationService } from '../../automations/automation-service'
import type { AgentAwakeService } from '../../power/agent-awake-service'
import type { CrashReportStore } from '../../crash-reporting/reports/crash-report-store'
import type { KeybindingService } from '../../keybindings/keybinding-service'
import {
  getSavedRuntimeAiVaultHostInfos,
  deleteRuntimeAiVaultSession,
  prepareRuntimeAiVaultSessionResume,
  resolveRuntimeAiVaultSessionTitles,
  scanRuntimeAiVaultSessions
} from '../../ai-vault/runtime-hosts/runtime-session-scanner'
import { callRuntimeSessionSearch } from '../../ai-vault/runtime-hosts/runtime-session-search-call'
import { configureRuntimeAiVaultSessionDelete } from '../ai-vault/ai-vault-delete'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../../runtime/agent-session/structured-agent-session-host-refusal'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { PluginService } from '../../plugins/plugin-service'
import type { PluginMarketplaceHandlerServices } from '../plugin-marketplaces'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/catalog/runtime-environment-registry-root'
import {
  closeNotificationDismissalsBeforeRelaunch,
  type CoreHandlerLifecycleOptions
} from './core-handler-lifecycle'

let registration: Promise<void> | null = null

export async function registerCoreHandlers(
  store: Store,
  runtime: OrcaRuntimeService,
  stats: StatsCollector,
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
): Promise<void> {
  // macOS activation can replace the window without ending the app; refresh trusted IDs but register IPC once.
  setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId)
  setTrustedClipboardRendererWebContentsId(mainWindowWebContentsId)
  setTrustedUIRendererWebContentsId(mainWindowWebContentsId)
  setAgentBrowserBridgeRef(runtime.getAgentBrowserBridge())
  return (registration ??= (async () => {
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
    registerPreflightHandlers(store)
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
    registerGitHubHandlers(store, stats, runtime)
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
      registerPluginHandlers(store, pluginService, marketplaceServices)
    }
    registerTelemetryHandlers(store)
    registerOrcaProfileHandlers(store, {
      onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch,
      onAuthMutation: lifecycleOptions.onOrcaProfileAuthMutation,
      onBeforeSignOut: lifecycleOptions.onBeforeOrcaProfileSignOut,
      onAfterSignOut: lifecycleOptions.onAfterOrcaProfileSignOut
    })
    registerBrowserHandlers(store)
    registerShellHandlers(store)
    registerPetHandlers()
    registerSessionHandlers(store, runtime)
    registerUIHandlers(store, { isDashboardPopoutRenderer })
    registerEmulatorFrameStreamHandlers()
    registerEmulatorVideoStreamHandlers((id) =>
      runtime.getEmulatorBridge()?.getIosVideoStreamUrl(id)
    )
    registerEmulatorScrcpyTouchHandler()
    registerEmulatorScrcpyKeyboardHandler()
    registerWorkspaceSpaceHandlers(store)
    registerWorkspacePortHandlers(store)
    registerLinkPreviewHandlers()
    registerLocalhostWorktreeLabelHandlers(store)
    registerFilesystemHandlers(store, commitMessageAgentEnv)
    registerFilesystemWatcherHandlers()
    registerRuntimeHandlers(runtime)
    const hostsReady = registerRuntimeHostHandlers(store, lifecycleOptions.hostInitialization)
    registerWslMoveWiring(store, runtime)
    registerWslDriveProjectHandlers(store, runtime)
    installProjectRuntimeGitRouter(store)
    registerEphemeralVmHandlers(store, pluginService)
    // Session history and terminal resume are not chats; a refused host leaves nothing to check.
    const ensureStructuredSessionOwnership = () =>
      ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
    registerAiVaultSearchHandlers({
      callRuntimeSearch: (environmentId, method, params) =>
        callRuntimeSessionSearch(
          getRuntimeEnvironmentRegistryRoot(),
          environmentId,
          method,
          params
        ),
      ensureStructuredSessionOwnership
    })
    registerAiVaultHandlers({
      getUserDataPath: () => app.getPath('userData'),
      ensureStructuredSessionOwnership,
      getAdditionalCodexHomePaths: lifecycleOptions.getAdditionalAiVaultCodexHomePaths,
      prepareSessionResume: lifecycleOptions.prepareAiVaultSessionResume,
      getActiveRuntimeAiVaultHostInfos: async () =>
        await getSavedRuntimeAiVaultHostInfos(getRuntimeEnvironmentRegistryRoot()),
      scanRuntimeAiVaultSessions: async (environmentId, args, options) =>
        scanRuntimeAiVaultSessions(
          getRuntimeEnvironmentRegistryRoot(),
          environmentId,
          args,
          options
        ),
      resolveRuntimeAiVaultSessionTitles: async (environmentId, args) =>
        resolveRuntimeAiVaultSessionTitles(
          getRuntimeEnvironmentRegistryRoot(),
          environmentId,
          args
        ),
      prepareRuntimeSessionResume: async (environmentId, args) =>
        prepareRuntimeAiVaultSessionResume(getRuntimeEnvironmentRegistryRoot(), environmentId, args)
    })
    configureRuntimeAiVaultSessionDelete((environmentId, args) =>
      deleteRuntimeAiVaultSession(getRuntimeEnvironmentRegistryRoot(), environmentId, args)
    )
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
    registerSpeechHandlers(store, commitMessageAgentEnv)
    void hostsReady.catch((error: unknown) =>
      console.warn('[startup] Host initialization failed:', error)
    )
    if (!lifecycleOptions.deferHostInitialization) {
      await hostsReady
    }
  })())
}
