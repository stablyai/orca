import { installProviderAccountCatalogWarmup } from '../../providers/accounts/provider-account-catalog-warmup'
import { createDesktopCodexSessionMigration } from '../../codex/history/backfill/desktop-codex-session-migration'
import { KeybindingService } from '../../keybindings/keybinding-service'
import { parseSearchShortcutChoice } from '../../../shared/keybindings/search-shortcut-opt-in'
import { toSearchShortcutPluginOwners } from '../../../shared/keybindings/search-shortcut-plugin-owners'
import { createProviderAccountServices } from '../../providers/accounts/provider-account-services'
import {
  hasOpenCodeGoApiKey,
  readOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../../opencode/accounts/opencode-go-api-key-store'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import type { DesktopCore } from '../../core-desktop/desktop-core'
import type { Store } from '../../persistence/loading-store/store'
import { createDesktopOrcaAccountService } from '../desktop-orca-account-service'
import { installOrcaServerSignIn, OrcaServerSignIn } from '../../orca-profiles/orca-server-sign-in'
import { GoogleConnect, installGoogleConnect } from '../../google/google-connect'
import { setBotToolSignInBrowser } from '../../bots/tool-oauth/bot-tool-sign-in-flows'

export type DesktopAccountServiceDeps = {
  store: Store
  homePath: string
  isQuitting: () => boolean
  openExternal: (url: string) => Promise<void>
}

export async function initializeMainProcessAccountServices(
  core: DesktopCore,
  { store, homePath, isQuitting, openExternal }: DesktopAccountServiceDeps
): Promise<void> {
  if (!core.claudeUsage || !core.codexUsage) {
    throw new Error('Usage stores must be initialized before account services')
  }
  core.codexSessionMigration = createDesktopCodexSessionMigration(
    store,
    () => core.codexRuntimeHome,
    isQuitting
  )
  const services = createProviderAccountServices(store, {
    codexAccountLifecycle: { onHostSystemDefaultSelected: core.codexSessionMigration.requestRun },
    setClaudeStatusLineListener: (listener) => agentHookServer.setClaudeStatusLineListener(listener)
  })
  core.rateLimits = services.rateLimits
  core.codexRuntimeHome = services.codexRuntimeHome
  // Saving the field rewrites it even unchanged; only a new host folder or sharing switch counts.
  const importSetting = (): string =>
    `${store.getSettings().codexSessionSourceHome?.host ?? ''}\0${store.getSettings().codexShareHistoryAcrossAccounts}`
  let lastImportSetting = importSetting()
  store.onSettingsChanged(() => {
    const next = importSetting()
    if (next !== lastImportSetting) {
      lastImportSetting = next
      services.codexRuntimeHome.importCodexHistoryInBackground({ settingChanged: true })
    }
  })
  core.codexAccounts = services.codexAccounts
  core.claudeRuntimeAuth = services.claudeRuntimeAuth
  core.claudeAccounts = services.claudeAccounts
  core.orcaAccount = createDesktopOrcaAccountService(openExternal)
  // A paired client may sign this host in too (D3); the desktop keeps its own window sign-in.
  installOrcaServerSignIn(new OrcaServerSignIn({ account: core.orcaAccount }))
  installGoogleConnect(new GoogleConnect({ openBrowser: openExternal }))
  setBotToolSignInBrowser(openExternal)
  // Defer shared-home migration; compatibility launches re-arm non-destructive scans for new rollouts (#4444, #8612, #12480).
  core.codexSessionMigration.scheduleInitialRun()
  installProviderAccountCatalogWarmup(store)
  await store.migrateLegacyOpenCodeGoApiKey({
    has: hasOpenCodeGoApiKey,
    read: readOpenCodeGoApiKey,
    save: saveOpenCodeGoApiKey
  })
  core.keybindings = new KeybindingService({
    homePath,
    getLegacyOverrides: () => store.getSettings().keybindings,
    legacyTabSwitchDefaults: store.getSettings().tabSwitchKeybindingSeed === 'legacy',
    legacySearchDefaults:
      (process.platform === 'darwin'
        ? store.getSettings().searchKeybindingSeed
        : store.getSettings().nonMacSearchKeybindingSeed) === 'legacy',
    readSearchShortcutChoice: () =>
      parseSearchShortcutChoice(store.getSettings().searchShortcutOptIn),
    persistSearchShortcutChoice: async (choice) => {
      await store.updateSettingsAndFlush({ searchShortcutOptIn: choice })
    },
    getSearchShortcutPluginOwners: () =>
      toSearchShortcutPluginOwners(state.pluginService?.contentPacks.commands.list() ?? [])
  })
  browserManager.setSettingsResolver(() => ({ keybindings: core.keybindings?.getOverrides() }))
}
