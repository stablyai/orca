import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'

export function listingFromEntry(entry: AgentModelCatalogEntry): CodexModelCatalogListing {
  return {
    models: entry.models.map((model) => ({ ...model })),
    speedTiersByModel: new Map(Object.entries(entry.speedTiersByModel))
  }
}

/** The exact tier the account's stored catalog names for a model's speed; no I/O. */
export function codexKnownSpeedTier(
  catalogAccess: CodexSessionCatalogAccess | undefined,
  model: string,
  speed: string
): string | undefined {
  const byModel = catalogAccess?.store.get(catalogAccess.fingerprint)?.speedTiersByModel
  const tiers = byModel && Object.hasOwn(byModel, model) ? byModel[model] : undefined
  return tiers && Object.hasOwn(tiers, speed) ? tiers[speed] : undefined
}

/** Acquisition uses known choices only; picker reads discover new choices later. */
export function codexAcquireCatalogListing(
  catalogAccess: CodexSessionCatalogAccess | undefined
): CodexModelCatalogListing | null {
  const entry = catalogAccess?.store.get(catalogAccess.fingerprint)
  return entry ? listingFromEntry(entry) : null
}
