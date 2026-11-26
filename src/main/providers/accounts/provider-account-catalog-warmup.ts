import type { Store } from '../../persistence/loading-store/store'
import { prewarmStructuredAgentModelCatalogs } from '../../runtime/agent-session/model-catalog/structured-agent-model-catalog-wiring'

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

export function installProviderAccountCatalogWarmup(store: Store): void {
  store.onSettingsChanged((updates) => {
    // An account switch would otherwise leave the next chat's picker on a cold catalog.
    if (MODEL_CATALOG_ACCOUNT_SETTINGS.some((key) => key in updates)) {
      prewarmStructuredAgentModelCatalogs()
    }
  })
}
