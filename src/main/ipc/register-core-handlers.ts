import { registerAppHandlers } from './app'
import { registerCliHandlers } from './cli'
import { registerPreflightHandlers } from './preflight'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StatsCollector } from '../stats/collector'
import { registerFilesystemHandlers } from './filesystem'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { registerClaudeUsageHandlers } from './claude-usage'
import { registerCodexUsageHandlers } from './codex-usage'
import { registerGitHubHandlers } from './github'
import { registerLinearHandlers } from './linear'
import { registerFeedbackHandlers } from './feedback'
import { registerExportHandlers } from './export'
import { registerStatsHandlers } from './stats'
import { registerRateLimitHandlers } from './rate-limits'
import { registerRuntimeHandlers } from './runtime'
import { registerNotificationHandlers } from './notifications'
import { setTrustedBrowserRendererWebContentsId, setAgentBrowserBridgeRef } from './browser'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerBrowserHandlers } from './browser'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { registerShellHandlers } from './shell'
import { registerUIHandlers } from './ui'
import { registerCodexAccountHandlers } from './codex-accounts'
import { registerAgentHookHandlers } from './agent-hooks'
import { registerClaudeAccountHandlers } from './claude-accounts'
import { warmSystemFontFamilies } from '../system-fonts'
import {
  registerClipboardHandlers,
  registerUpdaterHandlers
} from '../window/attach-main-window-services'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { ClaudeAccountService } from '../claude-accounts/service'

let registered = false

export function registerCoreHandlers(
  store: Store,
  runtime: OrcaRuntimeService,
  stats: StatsCollector,
  claudeUsage: ClaudeUsageStore,
  codexUsage: CodexUsageStore,
  codexAccounts: CodexAccountService,
  claudeAccounts: ClaudeAccountService,
  rateLimits: RateLimitService,
  mainWindowWebContentsId: number | null = null
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
  registerCodexAccountHandlers(codexAccounts)
  registerAgentHookHandlers()
  registerClaudeAccountHandlers(claudeAccounts)
  registerRateLimitHandlers(rateLimits)
  registerGitHubHandlers(store, stats)
  registerLinearHandlers()
  registerFeedbackHandlers()
  registerExportHandlers()
  registerStatsHandlers(stats)
  registerNotificationHandlers(store)
  registerSettingsHandlers(store)
  registerBrowserHandlers()
  // Why: applyPendingCookieImport MUST run before restorePersistedUserAgent
  // because the latter calls session.fromPartition() which initializes
  // CookieMonster. The pending import replaces the live DB file so
  // CookieMonster reads the imported cookies on first access.
  browserSessionRegistry.applyPendingCookieImport()
  browserSessionRegistry.restorePersistedUserAgent()
  registerShellHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerFilesystemHandlers(store)
  registerFilesystemWatcherHandlers()
  registerRuntimeHandlers(runtime)
  registerClipboardHandlers()
  registerUpdaterHandlers(store)
  warmSystemFontFamilies()
}
