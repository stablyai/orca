import { changedAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { updateSessionSearchInService } from '../ai-vault/session-scanner-service-spawn'
import { createChildSessionSearchService } from './session-search-child-service'
import { installSessionSearchPolicySource } from './session-search-policy'
import {
  installSessionSearchScopeCatalogSource,
  type SessionSearchScopeCatalogSource
} from './session-search-scope-catalog'
import { setSessionSearchService } from './session-search-service-registry'
import {
  installSessionSearchDataRoot,
  sessionSearchServiceInit
} from './session-search-service-init'
import { sessionSearchSqliteAvailable } from './session-search-sqlite-support'
let installed = false

/** Register even when disabled so callers distinguish denied consent from an unsupported host. */
export function installChildSessionSearchService(args: {
  dataRoot: string
  getSettings: () => Pick<GlobalSettings, 'aiVaultSearch'>
  /** How a Workspace or Project scope becomes this host's own paths. */
  getScopeCatalog?: SessionSearchScopeCatalogSource
}): { dispose(): void } | null {
  if (!sessionSearchSqliteAvailable()) {
    return null
  }
  installed = true
  installSessionSearchDataRoot(args.dataRoot)
  installSessionSearchPolicySource(args.getSettings)
  installSessionSearchScopeCatalogSource(args.getScopeCatalog ?? null)
  setSessionSearchService(createChildSessionSearchService())
  pushSessionSearchPolicy()
  return {
    dispose: () => {
      installed = false
      installSessionSearchScopeCatalogSource(null)
    }
  }
}

export function applySessionSearchSettingsChange(
  before: Pick<GlobalSettings, 'aiVaultSearch'>,
  after: Pick<GlobalSettings, 'aiVaultSearch'>
): void {
  if (!changedAiVaultSearchSettings(before, after)) {
    return
  }
  if (installed) {
    pushSessionSearchPolicy()
  }
}

function pushSessionSearchPolicy(): void {
  const init = sessionSearchServiceInit()
  if (init) {
    updateSessionSearchInService(init)
  }
}
