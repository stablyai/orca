import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { localAiVaultScanRoots } from '../ai-vault/cached-session-list'
import { installInProcessSessionSearchService } from '../ai-vault-search/session-search-in-process-service'

/**
 * orcad's session search registration.
 *
 * In this process and not a scanner child: orcad ships only the watcher and the
 * daemon entries beside `orcad.js`, so there is no scanner-service child here to
 * own the index — and this process is the sole writer, so nothing can race it.
 * Null on a host whose Node has no `node:sqlite`, which is orcad's stated floor.
 */
export async function installOrcadSessionSearchService(args: {
  userDataPath: string
  getSettings: () => Pick<GlobalSettings, 'aiVaultSearch'>
}): Promise<{ dispose(): void } | null> {
  return installInProcessSessionSearchService({
    dataRoot: args.userDataPath,
    roots: { executionHostId: LOCAL_EXECUTION_HOST_ID },
    resolveRoots: localAiVaultScanRoots,
    settings: resolveAiVaultSearchSettings(args.getSettings()),
    onError: (error) => console.error('[orcad] session search:', error)
  })
}
