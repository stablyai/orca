import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'

import {
  type AiVaultSearchSettings,
  resolveAiVaultSearchSettings
} from '../../../shared/ai-vault/search/ai-vault-search-settings'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { localAiVaultScanRoots } from '../../ai-vault/discovery/ai-vault-scan-roots'
import { installInProcessSessionSearchService } from '../../ai-vault-search/session-search-in-process-service'
import {
  localSessionSearchScopeCatalogSource,
  type SessionSearchScopeStore
} from '../../ai-vault-search/scope/session-search-store-scope-catalog'

/** Index in-process as sole writer; the scanner child has no installed search data root. */
export async function installOrcadSessionSearchService(args: {
  userDataPath: string
  getSettings: () => Pick<GlobalSettings, 'aiVaultSearch'>
  scopeStore: SessionSearchScopeStore
}): Promise<{ apply(settings: AiVaultSearchSettings): void; dispose(): void } | null> {
  return installInProcessSessionSearchService({
    dataRoot: args.userDataPath,
    roots: { executionHostId: LOCAL_EXECUTION_HOST_ID },
    resolveRoots: localAiVaultScanRoots,
    settings: resolveAiVaultSearchSettings(args.getSettings()),
    getScopeCatalog: localSessionSearchScopeCatalogSource(args.scopeStore),
    onError: (error) => console.error('[orcad] session search:', error)
  })
}
