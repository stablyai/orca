import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { resolveAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { localAiVaultScanRoots } from '../ai-vault/cached-session-list'
import { installInProcessSessionSearchService } from '../ai-vault-search/session-search-in-process-service'

// Headless search owns its index here; the Vault companion receives no search initialization.
export async function installOrcadSessionSearchService(args: {
  userDataPath: string
  getSettings: () => Pick<GlobalSettings, 'aiVaultSearch'>
}): Promise<{ apply(settings: AiVaultSearchSettings): void; dispose(): void } | null> {
  return installInProcessSessionSearchService({
    dataRoot: args.userDataPath,
    roots: { executionHostId: LOCAL_EXECUTION_HOST_ID },
    resolveRoots: localAiVaultScanRoots,
    settings: resolveAiVaultSearchSettings(args.getSettings()),
    onError: (error) => console.error('[orcad] session search:', error)
  })
}
