import { registerAppHandlers } from './app'
import { registerCliHandlers } from './cli'
import { registerPreflightHandlers } from './preflight'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StatsCollector } from '../stats/collector'
import {
  registerFilesystemHandlers,
  type CommitMessageAgentEnvironmentResolvers
} from './filesystem'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { registerClaudeUsageHandlers } from './claude-usage'
import { registerCodexUsageHandlers } from './codex-usage'
import { registerOpenCodeUsageHandlers } from './opencode-usage'
import { registerGitHubHandlers } from './github'
import { registerGitLabHandlers } from './gitlab'
import { registerHostedReviewHandlers } from './hosted-review'
import { registerLinearHandlers } from './linear'
import { registerFeedbackHandlers } from './feedback'
import { registerExportHandlers } from './export'
import { registerStatsHandlers } from './stats'
import { registerMemoryHandlers } from './memory'
import { registerRateLimitHandlers } from './rate-limits'
import { registerRuntimeHandlers } from './runtime'
import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
import { registerNotificationHandlers } from './notifications'
import { registerNotebookHandlers } from './notebook'
import { registerOnboardingHandlers } from './onboarding'
import { registerDeveloperPermissionHandlers } from './developer-permissions'
import { registerComputerUsePermissionHandlers } from './computer-use-permissions'
import { setTrustedBrowserRendererWebContentsId, setAgentBrowserBridgeRef } from './browser'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerSkillsHandlers } from './skills'
import { registerWorkspaceSpaceHandlers } from './workspace-space'
import { registerAutomationHandlers } from './automations'
import { registerTelemetryHandlers } from './telemetry'
import { registerBrowserHandlers } from './browser'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { registerShellHandlers } from './shell'
import { registerPetHandlers } from './pet'
import { registerUIHandlers } from './ui'
import { registerSpeechHandlers } from './speech'
import { registerCodexAccountHandlers } from './codex-accounts'
import { registerAgentHookHandlers } from './agent-hooks'
import { registerAgentTrustHandlers } from './agent-trust'
import { registerClaudeAccountHandlers } from './claude-accounts'
import { warmSystemFontFamilies } from '../system-fonts'
import {
  registerClipboardHandlers,
  registerUpdaterHandlers
} from '../window/attach-main-window-services'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { AutomationService } from '../automations/service'
import type { AgentAwakeService } from '../agent-awake-service'

let registered = false

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
  agentAwakeService?: AgentAwakeService
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

  registerAppHandlers()
  registerCliHandlers()
  registerPreflightHandlers()
  registerClaudeUsageHandlers(claudeUsage)
  registerCodexUsageHandlers(codexUsage)
  registerOpenCodeUsageHandlers(openCodeUsage)
  registerCodexAccountHandlers(codexAccounts)
  registerAgentHookHandlers()
  registerAgentTrustHandlers()
  registerClaudeAccountHandlers(claudeAccounts)
  registerRateLimitHandlers(rateLimits)
  registerGitHubHandlers(store, stats)
  registerGitLabHandlers(store)
  registerHostedReviewHandlers(store, stats)
  registerLinearHandlers()
  registerFeedbackHandlers()
  registerExportHandlers()
  registerStatsHandlers(stats)
  registerMemoryHandlers(store)
  registerNotificationHandlers(store, runtime)
  registerNotebookHandlers(store)
  registerOnboardingHandlers(store)
  registerDeveloperPermissionHandlers()
  registerComputerUsePermissionHandlers()
  registerSettingsHandlers(store, agentAwakeService)
  registerSkillsHandlers(store)
  if (automations) {
    registerAutomationHandlers(store, automations)
  }
  registerTelemetryHandlers(store)
  registerBrowserHandlers()
  // Why: applyPendingCookieImport MUST run before restorePersistedUserAgent
  // because the latter calls session.fromPartition() which initializes
  // CookieMonster. The pending import replaces the live DB file so
  // CookieMonster reads the imported cookies on first access.
  browserSessionRegistry.applyPendingCookieImport()
  browserSessionRegistry.restorePersistedUserAgent()
  registerShellHandlers()
  registerPetHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerWorkspaceSpaceHandlers(store)
  if (commitMessageAgentEnv) {
    registerFilesystemHandlers(store, commitMessageAgentEnv)
  } else {
    registerFilesystemHandlers(store)
  }
  registerFilesystemWatcherHandlers()
  registerRuntimeHandlers(runtime)
  registerRuntimeEnvironmentHandlers()
  registerClipboardHandlers()
  registerUpdaterHandlers(store)
  registerSpeechHandlers(store)
  warmSystemFontFamilies()
}
