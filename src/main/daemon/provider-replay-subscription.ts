import type { IPtyProvider } from '../providers/types'

export function subscribeToProviderReplay(
  providers: readonly IPtyProvider[],
  callback: (payload: { id: string; data: string }) => void,
  trackedSubscriptions: (() => void)[]
): () => void {
  const unsubscribes = providers.map((provider) => provider.onReplay(callback))
  let active = true
  const trackedUnsubscribe = (): void => {
    if (!active) {
      return
    }
    active = false
    const index = trackedSubscriptions.indexOf(trackedUnsubscribe)
    if (index !== -1) {
      trackedSubscriptions.splice(index, 1)
    }
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
  trackedSubscriptions.push(trackedUnsubscribe)
  return trackedUnsubscribe
}
