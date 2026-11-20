import { installProviderAccountCatalogWarmup } from '../../providers/accounts/provider-account-catalog-warmup'
import { createDesktopCodexSessionMigration } from '../../codex/history/backfill/desktop-codex-session-migration'
import { app, shell } from 'electron'
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
import { createDesktopOrcaAccountService } from '../desktop-orca-account-service'
import { installOrcaServerSignIn, OrcaServerSignIn } from '../../orca-profiles/orca-server-sign-in'
import { GoogleConnect, installGoogleConnect } from '../../google/google-connect'
import { setBotToolSignInBrowser } from '../../bots/tool-oauth/bot-tool-sign-in-flows'

export async function initializeMainProcessAccountServices(): Promise<void> {
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
  state.codexAccounts = services.codexAccounts
  state.claudeRuntimeAuth = services.claudeRuntimeAuth
  state.claudeAccounts = services.claudeAccounts
  state.orcaAccount = createDesktopOrcaAccountService()
  // A paired client may sign this host in too (D3); the desktop keeps its own window sign-in.
  installOrcaServerSignIn(new OrcaServerSignIn({ account: state.orcaAccount }))
  installGoogleConnect(new GoogleConnect({ openBrowser: (url) => shell.openExternal(url) }))
  setBotToolSignInBrowser((url) => shell.openExternal(url))
  // Defer shared-home migration; compatibility launches re-arm non-destructive scans for new rollouts (#4444, #8612, #12480).
  state.codexSessionMigration.scheduleInitialRun()
  installProviderAccountCatalogWarmup(store)
  await store.migrateLegacyOpenCodeGoApiKey({
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
