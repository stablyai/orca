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
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

export function codexAcquireCatalogAccess(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>
): CodexSessionCatalogAccess | undefined {
  return agentModelCatalogSessionAccess(deps.modelCatalog, CODEX_STRUCTURED_AGENT, launch.codexHome)
}

/** Use saved catalog knowledge for Fast restore without waiting on discovery. */
export function codexAcquireFastModeCatalog(input: {
  catalogAccess: CodexSessionCatalogAccess | undefined
  opened: Pick<CodexOpenedThread, 'model' | 'effort'>
  restoreNeedsCatalog: boolean
}): CodexSessionOptionCatalog | null {
  if (!input.restoreNeedsCatalog) {
    return null
  }
  const listing = codexAcquireCatalogListing(input.catalogAccess)
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
