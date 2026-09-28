import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { sessionSearchDatabasePath } from './session-search-database-path'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import { SessionSearchInstance } from './session-search-instance'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import { setSessionSearchService } from './session-search-service-registry'
import { isSqliteAvailable } from '../sqlite/sync-database'

/** Headless hosts keep index ownership here; their Vault companions do not initialize it. */
export function installInProcessSessionSearchService(args: {
  dataRoot: string
  roots: SessionSearchScanRoots
  resolveRoots?: SessionSearchIndexerOptions['resolveRoots']
  settings: AiVaultSearchSettings
  onError?: (error: unknown) => void
}): { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null {
  if (!isSqliteAvailable()) {
    return null
  }
  const instance = new SessionSearchInstance({
    databasePath: sessionSearchDatabasePath(args.dataRoot),
    roots: args.roots,
    resolveRoots: args.resolveRoots,
    ...(args.onError ? { onError: args.onError } : {})
  })
  instance.apply(args.settings)
  setSessionSearchService({
    search: (request, hostScope) => instance.search(request, hostScope),
    status: async () => instance.status(),
    reconcile: () => instance.reconcile()
  })
  return {
    // Why exposed: on these hosts a settings write reaches the index through this
    // object, there being no scanner child to forward a policy to.
    apply: (settings) => instance.apply(settings),
    dispose: () => {
      setSessionSearchService(null)
      instance.close()
    }
  }
}
