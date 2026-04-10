import { registerCliHandlers } from './cli'
import { registerPreflightHandlers } from './preflight'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { StatsCollector } from '../stats/collector'
import { registerFilesystemHandlers } from './filesystem'
import { registerClaudeUsageHandlers } from './claude-usage'
import { registerGitHubHandlers } from './github'
import { registerStatsHandlers } from './stats'
import { registerRuntimeHandlers } from './runtime'
import { registerNotificationHandlers } from './notifications'
import { setTrustedBrowserRendererWebContentsId } from './browser'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerBrowserHandlers } from './browser'
import { registerShellHandlers } from './shell'
import { registerUIHandlers } from './ui'
import { warmSystemFontFamilies } from '../system-fonts'
import {
  registerClipboardHandlers,
  registerUpdaterHandlers
} from '../window/attach-main-window-services'
import type { ClaudeUsageStore } from '../claude-usage/store'

export function registerCoreHandlers(
  store: Store,
  runtime: OrcaRuntimeService,
  stats: StatsCollector,
  claudeUsage: ClaudeUsageStore,
  mainWindowWebContentsId: number | null = null
): void {
  setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId)
  registerCliHandlers()
  registerPreflightHandlers()
  registerClaudeUsageHandlers(claudeUsage)
  registerGitHubHandlers(store, stats)
  registerStatsHandlers(stats)
  registerNotificationHandlers(store)
  registerSettingsHandlers(store)
  registerBrowserHandlers()
  registerShellHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store)
  registerFilesystemHandlers(store)
  registerRuntimeHandlers(runtime)
  registerClipboardHandlers()
  registerUpdaterHandlers(store)
  warmSystemFontFamilies()
}
