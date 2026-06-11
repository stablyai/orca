import { registerAppHandlers } from './app'
import { registerCliHandlers } from './cli'
import { registerPreflightHandlers } from './preflight'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StatsCollector } from '../stats/collector'
import { registerFilesystemHandlers } from './filesystem'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { registerClaudeUsageHandlers } from './claude-usage'
import { registerCodexUsageHandlers } from './codex-usage'
import { registerOpenCodeUsageHandlers } from './opencode-usage'
import { registerGitHubHandlers } from './github'
import { registerGitLabHandlers } from './gitlab'
import { registerHostedReviewHandlers } from './hosted-review'
import { registerLinearHandlers } from './linear'
import { registerJiraHandlers } from './jira'
import { registerFeedbackHandlers } from './feedback'
import { registerCrashReportingHandlers } from './crash-reporting'
import { registerExportHandlers } from './export'
import { registerStatsHandlers } from './stats'
import { registerMemoryHandlers } from './memory'
import { registerRateLimitHandlers } from './rate-limits'
import { registerRuntimeHandlers } from './runtime'
import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
import { registerAiVaultHandlers } from './ai-vault'
import { registerNotificationHandlers } from './notifications'
import { registerNotebookHandlers } from './notebook'
import { registerOnboardingHandlers } from './onboarding'
import { registerDeveloperPermissionHandlers } from './developer-permissions'
import { registerComputerUsePermissionHandlers } from './computer-use-permissions'
import { setTrustedBrowserRendererWebContentsId, setAgentBrowserBridgeRef } from './browser'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerDiagnosticsHandlers } from './diagnostics'
import { registerSkillsHandlers } from './skills'
import { registerWorkspaceSpaceHandlers } from './workspace-space'
import { registerWorkspacePortHandlers } from './workspace-ports'
import { registerAutomationHandlers } from './automations'
import { registerKeybindingHandlers } from './keybindings'
import { registerTelemetryHandlers } from './telemetry'
import { registerBrowserHandlers } from './browser'
import { registerShellHandlers } from './shell'
import { registerPetHandlers } from './pet'
import { registerUIHandlers } from './ui'
import { registerEmulatorFrameStreamHandlers } from './emulator-frame-stream'
import { registerSpeechHandlers } from './speech'
import { registerCodexAccountHandlers } from './codex-accounts'
import { registerAgentHookHandlers } from './agent-hooks'
import { registerAgentTrustHandlers } from './agent-trust'
import { registerClaudeAccountHandlers } from './claude-accounts'
import { warmSystemFontFamilies } from '../system-fonts'
import { registerUpdaterHandlers } from '../window/attach-main-window-services'
import { registerClipboardHandlers } from '../window/clipboard-ipc-handlers'
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

let registered = false

type CoreHandlerLifecycleOptions = {
  onBeforeRelaunch?: () => void
  getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
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
  lifecycleOptions: CoreHandlerLifecycleOptions = {}
): void {
  // Why: on macOS the app can stay alive after all windows close, then
  // openMainWindow() is called again on 'activate'. ipcMain.handle() throws
  // if a channel is registered twice, so we guard to register only once and
  // just update the per-window web-contents ID on subsequent calls.
  setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId)
  setAgentBrowserBridgeRef(runtime.getAgentBrowserBridge())
  if (registered) {
    return
  }
  registered = true

  registerAppHandlers(store, { onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch })
  registerCliHandlers()
  registerPreflightHandlers()
  registerClaudeUsageHandlers(claudeUsage)
  registerCodexUsageHandlers(codexUsage)
  registerOpenCodeUsageHandlers(openCodeUsage)
  registerCodexAccountHandlers(codexAccounts)
  registerAgentHookHandlers(runtime)
  registerAgentTrustHandlers()
  registerClaudeAccountHandlers(claudeAccounts)
  registerRateLimitHandlers(rateLimits)
  registerGitHubHandlers(store, stats)
  registerGitLabHandlers(store)
  registerHostedReviewHandlers(store, stats)
  registerLinearHandlers()
  registerJiraHandlers()
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
  registerDeveloperPermissionHandlers()
  // Why: diagnostics handlers are wired alongside telemetry but the two
  // lanes never share a code path — `ipc/diagnostics.ts` imports only from
  // `src/main/observability/`, never from `src/main/telemetry/`. Order is
  // not load-bearing; both register independent ipcMain channels.
  registerDiagnosticsHandlers()
  registerComputerUsePermissionHandlers()
  registerSettingsHandlers(store, agentAwakeService)
  registerSkillsHandlers(store)
  if (automations) {
    registerAutomationHandlers(store, automations)
  }
  if (keybindings) {
    registerKeybindingHandlers(keybindings)
  }
  registerTelemetryHandlers(store)
  registerBrowserHandlers()
  registerShellHandlers()
  registerPetHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerEmulatorFrameStreamHandlers()
  registerWorkspaceSpaceHandlers(store)
  registerWorkspacePortHandlers(store)
  if (commitMessageAgentEnv) {
    registerFilesystemHandlers(store, commitMessageAgentEnv)
  } else {
    registerFilesystemHandlers(store)
  }
  registerFilesystemWatcherHandlers()
  registerRuntimeHandlers(runtime)
  registerRuntimeEnvironmentHandlers()
  registerAiVaultHandlers({
    getAdditionalCodexHomePaths: lifecycleOptions.getAdditionalAiVaultCodexHomePaths
  })
  registerClipboardHandlers()
  registerUpdaterHandlers(store)
  registerSpeechHandlers(store)
  warmSystemFontFamilies()
}
