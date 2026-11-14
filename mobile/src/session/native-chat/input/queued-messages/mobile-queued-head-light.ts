/** Whether the composer previews sending the head queued card; only the head row subscribes. */
export type MobileQueuedHeadLight = {
  get: () => boolean
  set: (lit: boolean) => void
  subscribe: (listener: () => void) => () => void
}

// A store rather than list state, so a hold re-renders the one lit row, not every queued card.
export function createMobileQueuedHeadLight(): MobileQueuedHeadLight {
  let lit = false
  const listeners = new Set<() => void>()
  return {
    get: () => lit,
    set: (next) => {
      if (next !== lit) {
        lit = next
        listeners.forEach((listener) => listener())
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
