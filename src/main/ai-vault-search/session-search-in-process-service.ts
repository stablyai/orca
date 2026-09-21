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
 * Neither of these hosts has that child: orcad ships only the watcher and daemon
 * entries beside `orcad.js`, and the relay's AI Vault sidecar runs the remote
 * scanner, which reads through a filesystem provider and publishes nothing to the
 * transcript channel. On both, the process that would drive the index's reads is
 * this one, and it is the only writer, so the two-process rebuild race the
 * desktop rule avoids cannot arise here.
 *
 * Returns null on a runtime with no `node:sqlite`: both hosts are built for a
 * Node 18 floor, and a host that cannot hold an index registers nothing rather
 * than answering `disabled` for a reason that is not consent.
 */
export function installInProcessSessionSearchService(args: {
  dataRoot: string
  roots: SessionSearchScanRoots
  resolveRoots?: SessionSearchIndexerOptions['resolveRoots']
  settings: AiVaultSearchSettings
  onError?: (error: unknown) => void
}): { dispose(): void } | null {
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
    search: (request) => instance.search(request),
    status: async () => instance.status(),
    reconcile: () => instance.reconcile()
  })
  return {
    dispose: () => {
      setSessionSearchService(null)
      instance.close()
    }
  }
}
