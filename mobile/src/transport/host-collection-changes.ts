export type HostCollectionChange = { retiredHostIds: readonly string[] }

const listeners = new Set<(change: HostCollectionChange) => void>()

export function notifyHostCollectionChanged(change: HostCollectionChange): void {
  for (const listener of listeners) {
    listener(change)
  }
}

export function subscribeHostCollectionChanges(
  listener: (change: HostCollectionChange) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetHostCollectionChangeListenersForTests(): void {
  listeners.clear()
}
