import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { sessionSearchDatabasePath } from './session-search-database-path'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import { SessionSearchInstance } from './session-search-instance'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import { setSessionSearchService } from './session-search-service-registry'
import { sessionSearchSqliteAvailable } from './session-search-sqlite-support'

/**
 * Registration for the two hosts that have no scanner-service child of their own.
 *
 * The desktop puts the index in that child because the child is where the
 * transcript reader runs, so one read serves both the session list and the index.
 * Neither host gives that child the index: orcad's scanner child gets no search
 * data root and only lists sessions, and the relay's AI Vault sidecar runs the remote
 * scanner, which reads through a filesystem provider and publishes nothing to the
 * transcript channel. On both, the process that would drive the index's reads is
 * this one, and it is the only writer, so the two-process rebuild race the
 * desktop rule avoids cannot arise here.
 *
 * A runtime without SQLite registers no search service.
 */
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
    // Why exposed: on these hosts a settings write reaches the index through this
    // object, there being no scanner child to forward a policy to.
    apply: (settings) => instance.apply(settings),
    dispose: () => {
      setSessionSearchService(null)
      instance.close()
    }
  }
}
