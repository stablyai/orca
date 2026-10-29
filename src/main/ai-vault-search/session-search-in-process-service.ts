import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { sessionSearchDatabasePath } from './session-search-database-path'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import { SessionSearchInstance } from './session-search-instance'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import { setSessionSearchService } from './session-search-service-registry'
import { sessionSearchSqliteAvailable } from './session-search-sqlite-support'

/** Own the index where the scanner cannot publish transcript reads; skip hosts without SQLite. */
export function installInProcessSessionSearchService(args: {
  dataRoot: string
  roots: SessionSearchScanRoots
  resolveRoots?: SessionSearchIndexerOptions['resolveRoots']
  settings: AiVaultSearchSettings
  onError?: (error: unknown) => void
}): { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null {
  if (!sessionSearchSqliteAvailable()) {
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
    apply: (settings) => instance.apply(settings),
    dispose: () => {
      setSessionSearchService(null)
      instance.close()
    }
  }
}
