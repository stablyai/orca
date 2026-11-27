import { registerAppHandlers } from '../app'
import { canCreateWslHostService } from '../wsl/wsl-host-service-availability'
import { registerNonWindowsWslIpcStubs } from '../wsl/non-windows-wsl-ipc-stubs'
import { installProjectRuntimeGitRouter } from '../../workspaces/execution-host/project-runtime-git-router'
import type { Store } from '../../persistence/loading-store/store'
import { resolveDesktopAuthorizedPath } from '../filesystem/access/local-file-access-resolution'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerFilesystemHandlers } from '../filesystem/filesystem'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import { registerFilesystemWatcherHandlers } from '../filesystem/watchers/filesystem-watcher-handlers'
import { registerGitHubHandlers } from '../source-control/github'
import { registerLazyGitLabHandlers } from '../source-control/lazy-gitlab-handlers'
import { registerLazyLinearHandlers } from '../linear/lazy-linear-handlers'
import { registerLazyJiraHandlers } from '../jira/lazy-jira-handlers'
import { registerCrashReportingHandlers } from '../crash-reporting/crash-reporting'
import { registerStatsHandlers } from '../stats'
import { registerRateLimitHandlers } from '../rate-limits'
import { registerRuntimeHandlers } from '../runtime'
import { registerRuntimeHostHandlers } from './runtime-host-handler-registration'
import { registerLazyEphemeralVmHandlers } from '../ephemeral-vm/lazy-ephemeral-vm-handlers'
import { registerLazyAiVaultHandlers } from '../ai-vault/lazy-ai-vault-handlers'
import { registerNativeChatHandlers } from '../native-chat'
import { registerNotificationHandlers } from '../notifications/notifications'
import { setAgentBrowserBridgeRef, registerBrowserHandlers } from '../browser/browser'
import { setTrustedBrowserRendererWebContentsId } from '../browser/browser-renderer-trust'
import { registerSessionHandlers } from '../session'
import { registerSettingsHandlers } from '../settings/settings'
import {
  registerLazySkillDeleteIpcHandlers,
  registerLazySkillsHandlers
} from '../skills/lazy-skills-handlers'
import { registerWorkspacePortHandlers } from '../ports/workspace-ports'
import { registerAutomationHandlers } from '../automations'
import { registerKeybindingHandlers } from '../keybindings'
import { registerTelemetryHandlers } from '../telemetry'
import { registerPluginHandlers } from '../plugins/plugins'
import { registerUIHandlers, setTrustedUIRendererWebContentsId } from '../ui'
import { registerLazyEmulatorHandlers } from '../emulator/lazy-emulator-handlers'
import { registerLazySpeechHandlers } from '../lazy-speech-handlers'
import { registerOrcaProfileHandlers } from '../profiles/orca-profiles'
import { registerCodexAccountHandlers } from '../accounts/codex-accounts'
import { registerAgentHookHandlers } from '../agent-hooks/agent-hooks'
import { getPtyIdForPaneKey } from '../pty/pane/key-state'
import { registerClaudeAccountHandlers } from '../accounts/claude-accounts'
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
  ensurePersistedStructuredAgentSessionHostUnlessRefused,
  ensureStructuredAgentSessionHostUnlessRefused
} from '../../runtime/agent-session/installation/structured-agent-session-host-refusal'
import { getAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { PluginService } from '../../plugins/plugin-service'
import type { PluginMarketplaceHandlerServices } from '../plugins/plugin-marketplaces'
import {
  closeNotificationDismissalsBeforeRelaunch,
  type CoreHandlerLifecycleOptions
} from './core-handler-lifecycle'
import { registerLazyRareIpcHandlers } from './lazy-rare-ipc-handlers'
import { registerLazyAccountAndDiagnosticIpcHandlers } from './lazy-account-and-diagnostic-ipc-handlers'
import { registerLazySecondaryIpcHandlers } from './lazy-secondary-ipc-handlers'
import { registerLazySetupIpcHandlers } from './lazy-setup-ipc-handlers'

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
  const { rendererCheckpoint } = lifecycleOptions
  if (!rendererCheckpoint) {
    throw new Error('Renderer shutdown checkpoint must be composed before core handlers')
  }
  return (registration ??= (async () => {
    registerAppHandlers(store, {
      rendererCheckpoint,
      onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch,
      onQuit: lifecycleOptions.onQuit,
      // Restart/profile switching closes this through will-quit; this callback covers relaunch exit.
      onBeforeRelaunchExit: () => closeNotificationDismissalsBeforeRelaunch(runtime)
    })
    registerLazyRareIpcHandlers(store)
    registerLazySetupIpcHandlers(store, codexAccounts, keybindings)
    registerCodexAccountHandlers(codexAccounts, () => store.getSettings())
    registerAgentHookHandlers(runtime, { getPtyIdForPaneKey })
    registerClaudeAccountHandlers(claudeAccounts, (change, held) =>
      runtime.moveRunningClaudePanes(change, held)
    )
    registerLazyAccountAndDiagnosticIpcHandlers(rateLimits)
    registerRateLimitHandlers(rateLimits, codexAccounts, () => store.getSettings())
    registerGitHubHandlers(store, stats, runtime)
    registerLazyGitLabHandlers(store)
    registerLazySecondaryIpcHandlers(store, stats, runtime)
    registerLazyLinearHandlers()
    registerLazyJiraHandlers(store, commitMessageAgentEnv)
    if (crashReports) {
      registerCrashReportingHandlers(crashReports)
    }
    registerStatsHandlers(stats)
    registerNotificationHandlers(store, runtime)
    registerSettingsHandlers(store, agentAwakeService)
    registerLazySkillsHandlers(store, runtime)
    registerLazySkillDeleteIpcHandlers(store, runtime)
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
    if (!lifecycleOptions.orcaAccount) {
      throw new Error('Orca account service must be initialized before core handlers')
    }
    registerOrcaProfileHandlers(store, lifecycleOptions.orcaAccount, {
      onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch
    })
    registerBrowserHandlers(store)
    registerSessionHandlers(store, runtime)
    registerUIHandlers(store, { isDashboardPopoutRenderer })
    registerLazyEmulatorHandlers((id) => runtime.getEmulatorBridge()?.getIosVideoStreamUrl(id))
    registerWorkspacePortHandlers(store)
    registerFilesystemHandlers(store, commitMessageAgentEnv)
    registerFilesystemWatcherHandlers()
    registerRuntimeHandlers(runtime)
    const hostsReady = registerRuntimeHostHandlers(store, lifecycleOptions.hostInitialization)
    if (process.platform === 'win32' || canCreateWslHostService()) {
      const [{ registerWslMoveWiring }, { registerWslDriveProjectHandlers }] = await Promise.all([
        import('../wsl/wsl-move-driver-wiring'),
        import('../wsl/wsl-drive-project-handlers')
      ])
      registerWslMoveWiring(store, runtime)
      registerWslDriveProjectHandlers(store, runtime)
    } else {
      registerNonWindowsWslIpcStubs()
    }
    installProjectRuntimeGitRouter(store)
    registerLazyEphemeralVmHandlers(store, pluginService)
    // Session history and terminal resume are not chats; skip booting an empty chat journal host.
    const ensureStructuredSessionOwnership = () =>
      ensurePersistedStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
    registerLazyAiVaultHandlers({
      ensureStructuredSessionOwnership,
      getAdditionalCodexHomePaths: lifecycleOptions.getAdditionalAiVaultCodexHomePaths,
      prepareSessionResume: lifecycleOptions.prepareAiVaultSessionResume
    })
    registerNativeChatHandlers()
    registerClipboardHandlers((path) => resolveDesktopAuthorizedPath(path, store), {
      localChatAttachmentStore: async () => {
        await ensureStructuredAgentSessionHostUnlessRefused(() =>
          runtime.ensureStructuredAgentSessionHost()
        )
        return getAgentSessionAttachmentStore()
      }
    })
    registerUpdaterHandlers()
    registerLazySpeechHandlers(store, commitMessageAgentEnv)
    void hostsReady.catch((error: unknown) =>
      console.warn('[startup] Host initialization failed:', error)
    )
    if (!lifecycleOptions.deferHostInitialization) {
      await hostsReady
    }
  })())
}
