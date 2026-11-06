import type { AgentModelCatalogListingDemand } from './agent-model-catalog-lister'

/** The readers sharing one catalog claim: it lives while any of them still wants it, until the
 *  last live one's deadline, and its last reader leaving ends it. Each reader's own `current`
 *  fences its own request, so one chat closing never ends another's. */
export function agentModelCatalogClaimReaders(controller: AbortController) {
  const readers = new Map<AgentModelCatalogListingDemand, () => void>()
  const wanted = (entry: AgentModelCatalogListingDemand): boolean =>
    !entry.signal?.aborted &&
    entry.current?.() !== false &&
    Date.now() < (entry.deadline ?? Infinity)
  const drop = (entry: AgentModelCatalogListingDemand): void => {
    const left = readers.get(entry)
    if (left) {
      entry.signal?.removeEventListener('abort', left)
      readers.delete(entry)
    }
  }
  // A reader that has left never comes back, so it is dropped as soon as it is seen.
  const live = function* (): Generator<AgentModelCatalogListingDemand> {
    for (const entry of readers.keys()) {
      if (wanted(entry)) {
        yield entry
      } else {
        drop(entry)
      }
    }
  }
  const any = (): boolean => !live().next().done
  return {
    any,
    all: () => [...live()],
    /** The latest deadline any live reader still has; the past once none is left. */
    latest(): number {
      let latest = -Infinity
      for (const entry of live()) {
        latest = Math.max(latest, entry.deadline ?? Infinity)
      }
      return latest
    },
    add(entry: AgentModelCatalogListingDemand): void {
      const left = (): void => {
        drop(entry)
        if (!any()) {
          controller.abort()
        }
      }
      readers.set(entry, left)
      entry.signal?.addEventListener('abort', left, { once: true })
    },
    /** Releases every reader's listener once the claim has ended. */
    clear(): void {
      for (const entry of readers.keys()) {
        drop(entry)
      }
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
