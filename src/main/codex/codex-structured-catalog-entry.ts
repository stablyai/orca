import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'

export function listingFromEntry(entry: AgentModelCatalogEntry): CodexModelCatalogListing {
  return {
    models: entry.models.map((model) => ({ ...model })),
    complete: entry.observation.complete,
    ...(entry.observation.configured ? { configured: entry.observation.configured } : {})
  }
}

/** Acquisition uses known choices only; picker reads discover new choices later. */
export function codexAcquireCatalogListing(
  catalogAccess: CodexSessionCatalogAccess | undefined
): CodexModelCatalogListing | null {
  const entry = catalogAccess?.read
    ? catalogAccess.read()
    : catalogAccess?.store.get(catalogAccess.fingerprint)
  return entry ? listingFromEntry(entry) : null
}
