import { createHash } from 'node:crypto'
import type { AgentSessionChoiceCatalog } from '../../../shared/agent-session-wire'
import type { AgentModelCatalogLiveListing } from './agent-model-catalog-store'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'

export function createAgentModelCatalogProcessObservations(
  deps: Pick<AgentModelCatalogServiceDeps, 'processScope' | 'getRecord'>
) {
  const listings = new Map<
    string,
    { scope: string; listing: AgentModelCatalogLiveListing; at: number }
  >()
  const processCatalog = (sessionId: string): AgentSessionChoiceCatalog | null => {
    const scope = deps.processScope?.(sessionId)
    const record = deps.getRecord(sessionId)
    if (!scope || !record || record.provider === 'codex') {
      return null
    }
    const saved = listings.get(sessionId)
    const observed = saved?.scope === scope ? saved : undefined
    const listing = observed?.listing
    const complete = listing !== undefined && listing.complete !== false
    return {
      authority: 'session',
      scopeId: createHash('sha256').update(scope).digest('hex'),
      models: listing?.models ?? [],
      complete,
      freshForMs: complete && observed ? Math.max(0, 120_000 - (Date.now() - observed.at)) : 0,
      ...(listing?.fastModeSupport ? { fastModeSupport: listing.fastModeSupport } : {})
    }
  }
  return {
    read: processCatalog,
    get: (sessionId: string) => listings.get(sessionId),
    clear: () => listings.clear(),
    record(
      sessionId: string,
      scope: string | null | undefined,
      listing: AgentModelCatalogLiveListing
    ) {
      if (scope) {
        if (listings.size >= 256 && !listings.has(sessionId)) {
          const oldest = listings.keys().next().value
          if (oldest !== undefined) {
            listings.delete(oldest)
          }
        }
        const prior = listings.get(sessionId)
        const display =
          listing.models.length === 0 && prior?.scope === scope
            ? { ...prior.listing, complete: false }
            : listing
        listings.set(sessionId, { scope, listing: display, at: Date.now() })
      }
    }
  }
}
