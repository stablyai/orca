import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import type {
  CodexSessionCatalogAccess,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredLaunch
} from './codex-structured-session-state'
import { codexAcquireCatalogListing } from './codex-structured-session-options'
import {
  composeCodexSessionOptionCatalog,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'

export function codexAcquireCatalogAccess(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>
): CodexSessionCatalogAccess | undefined {
  return agentModelCatalogSessionAccess(deps.modelCatalog, 'codex', launch.codexHome)
}

/** The one catalog read a fast-mode restore needs, store-first. Null degrades
 *  exactly as a failed listing always did: the restore proceeds without tiers. */
export async function codexAcquireFastModeCatalog(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  catalogAccess: CodexSessionCatalogAccess | undefined
  opened: Pick<CodexOpenedThread, 'model' | 'effort'>
  restoreNeedsCatalog: boolean
  timeoutMs: number | undefined
}): Promise<CodexSessionOptionCatalog | null> {
  if (!input.restoreNeedsCatalog) {
    return null
  }
  const listing = await codexAcquireCatalogListing(
    input.connection,
    input.catalogAccess,
    input.timeoutMs
  )
  if (!listing) {
    return null
  }
  try {
    return composeCodexSessionOptionCatalog(listing, {
      current: {
        ...(input.opened.model ? { model: input.opened.model } : {}),
        ...(input.opened.effort ? { effort: input.opened.effort } : {}),
        fastMode: true
      }
    })
  } catch {
    return null
  }
}
