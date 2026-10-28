import { app } from 'electron'
import { KeybindingService } from '../keybindings/keybinding-service'
import { createProviderAccountServices } from '../provider-account-services'
import { createCodexSessionMigrationScheduler } from '../codex/codex-session-migration-scheduler'
import { startCodexSessionBackfillInBackground } from '../codex/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from '../codex/codex-session-index-heal'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/codex-state-db-backfill-recovery'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import {
  hasOpenCodeGoApiKey,
  readOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../opencode/opencode-go-api-key-store'
import { agentHookServer } from '../agent-hooks/server'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { browserManager } from '../browser/browser-manager'
import { prewarmStructuredAgentModelCatalogs } from '../runtime/structured-agent-model-catalog-wiring'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogSettingsExpiry } from '../native-chat/agent-model-catalog/agent-model-catalog-account-expiry'
import { mainProcessState as state } from './main-process-state'

// Settings that change which account or binary a new chat's agent runs under.
const MODEL_CATALOG_ACCOUNT_SETTINGS = [
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'codexManagedAccounts',
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'claudeManagedAccounts',
  'agentDefaultEnv',
  'agentCmdOverrides'
] as const

export function initializeMainProcessAccountServices(): void {
  const store = state.store
  if (
    !store ||
    !state.claudeUsage ||
    !state.codexUsage ||
    !state.openCodeUsage ||
    !state.museUsage
  ) {
    throw new Error('Usage stores must be initialized before account services')
  }
  state.codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () =>
      state.codexRuntimeHome?.isHostSystemDefaultSessionMigrationEligible() === true,
    isQuitting: () => state.isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store.getSettings()),
    prepareScheduledRun: (scanDates) =>
      state.codexRuntimeHome?.prepareHostSystemDefaultSessionMigrationPass(scanDates),
    finishScheduledRun: () => state.codexRuntimeHome?.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  const services = createProviderAccountServices(store, {
    codexAccountLifecycle: { onHostSystemDefaultSelected: state.codexSessionMigration.requestRun },
    setClaudeStatusLineListener: (listener) => agentHookServer.setClaudeStatusLineListener(listener)
  })
  state.rateLimits = services.rateLimits
  state.codexRuntimeHome = services.codexRuntimeHome
  state.codexAccounts = services.codexAccounts
  state.claudeRuntimeAuth = services.claudeRuntimeAuth
  state.claudeAccounts = services.claudeAccounts
  void startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  // Defer shared-home migration; compatibility launches re-arm non-destructive scans for new rollouts (#4444, #8612, #12480).
  state.codexSessionMigration.scheduleInitialRun()
  const expireModelCatalogs = createAgentModelCatalogSettingsExpiry(
    agentModelCatalogStore,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    expireModelCatalogs(updates, settings)
    // An account switch would otherwise leave the next chat's picker on a cold catalog.
    if (MODEL_CATALOG_ACCOUNT_SETTINGS.some((key) => key in updates)) {
      prewarmStructuredAgentModelCatalogs()
    }
  })
  store.migrateLegacyOpenCodeGoApiKey({
    has: hasOpenCodeGoApiKey,
    read: readOpenCodeGoApiKey,
    save: saveOpenCodeGoApiKey
  })
  state.keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store.getSettings().keybindings,
    legacyTabSwitchSeed: {
      isPending: () => store.getSettings().tabSwitchKeybindingSeed === 'pending',
      markSeeded: () => store.updateSettings({ tabSwitchKeybindingSeed: 'done' })
    }
  })
  browserManager.setSettingsResolver(() => ({ keybindings: state.keybindings?.getOverrides() }))
}
