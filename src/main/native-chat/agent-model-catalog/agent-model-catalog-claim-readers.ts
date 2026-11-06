import type { AgentModelCatalogListingDemand } from './agent-model-catalog-lister'

/** The readers sharing one catalog claim: it lives while any of them still wants it, until the
 *  last one's deadline, and its last reader leaving ends it. */
export function agentModelCatalogClaimReaders(deadline: number, controller: AbortController) {
  const readers = new Set<AgentModelCatalogListingDemand>()
  let latest = deadline
  const wanted = (entry: AgentModelCatalogListingDemand): boolean =>
    !entry.signal?.aborted &&
    entry.current?.() !== false &&
    Date.now() < (entry.deadline ?? Infinity)
  // A reader that has left never comes back, so it is dropped as soon as it is seen.
  const any = (): boolean => {
    for (const entry of readers) {
      if (wanted(entry)) {
        return true
      }
      readers.delete(entry)
    }
    return false
  }
  return {
    any,
    all: () => [...readers],
    latest: () => latest,
    add(entry: AgentModelCatalogListingDemand): void {
      readers.add(entry)
      latest = Math.max(latest, entry.deadline ?? latest)
      entry.signal?.addEventListener(
        'abort',
        () => {
          if (!any()) {
            controller.abort()
          }
        },
        { once: true }
      )
    },
    /** A reader owns the claim's listing until its own deadline or cancellation. */
    ownership: (
      entry: AgentModelCatalogListingDemand,
      current: () => boolean
    ): AgentModelCatalogListingDemand => ({
      current: () => current() && wanted(entry),
      signal: entry.signal ? AbortSignal.any([controller.signal, entry.signal]) : controller.signal,
      deadline: entry.deadline
    })
  }
}
