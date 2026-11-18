import { installProviderAccountCatalogWarmup } from '../../providers/accounts/provider-account-catalog-warmup'
import { createDesktopCodexSessionMigration } from '../../codex/history/backfill/desktop-codex-session-migration'
import { app } from 'electron'
import { KeybindingService } from '../../keybindings/keybinding-service'
import { createProviderAccountServices } from '../../providers/accounts/provider-account-services'
import {
  hasOpenCodeGoApiKey,
  readOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../../opencode/accounts/opencode-go-api-key-store'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { mainProcessState as state } from '../main-process-state'

export function initializeMainProcessAccountServices(): void {
  const store = state.store
  if (!store || !state.claudeUsage || !state.codexUsage) {
    throw new Error('Usage stores must be initialized before account services')
  }
  state.codexSessionMigration = createDesktopCodexSessionMigration(
    store,
    () => state.codexRuntimeHome,
    () => state.isQuitting
  )
  const services = createProviderAccountServices(store, {
    codexAccountLifecycle: { onHostSystemDefaultSelected: state.codexSessionMigration.requestRun },
    setClaudeStatusLineListener: (listener) => agentHookServer.setClaudeStatusLineListener(listener)
  })
  state.rateLimits = services.rateLimits
  state.codexRuntimeHome = services.codexRuntimeHome
  state.codexAccounts = services.codexAccounts
  state.claudeRuntimeAuth = services.claudeRuntimeAuth
  state.claudeAccounts = services.claudeAccounts
  // Defer shared-home migration; compatibility launches re-arm non-destructive scans for new rollouts (#4444, #8612, #12480).
  state.codexSessionMigration.scheduleInitialRun()
  installProviderAccountCatalogWarmup(store)
  store.migrateLegacyOpenCodeGoApiKey({
    has: hasOpenCodeGoApiKey,
    read: readOpenCodeGoApiKey,
    save: saveOpenCodeGoApiKey
  })
  state.keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store.getSettings().keybindings,
    legacyTabSwitchDefaults: store.getSettings().tabSwitchKeybindingSeed === 'legacy',
    legacySearchDefaults:
      (process.platform === 'darwin'
        ? store.getSettings().searchKeybindingSeed
        : store.getSettings().nonMacSearchKeybindingSeed) === 'legacy'
  })
  browserManager.setSettingsResolver(() => ({ keybindings: state.keybindings?.getOverrides() }))
}
