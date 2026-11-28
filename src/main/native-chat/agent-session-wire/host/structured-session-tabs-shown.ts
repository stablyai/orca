type TabsShownListener = (sessionIds: readonly string[]) => void

const listeners = new Set<TabsShownListener>()

/** The runtime that draws chat rows learns here which chats had their tabs shown again in one batch
 *  (a re-added project's chats, #40409). Returns the unsubscribe. */
export function onStructuredSessionTabsShown(listener: TabsShownListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Advisory: a failing listener never fails the show; it is reported to `onError`. */
export function emitStructuredSessionTabsShown(
  sessionIds: readonly string[],
  onError: (error: unknown) => void
): void {
  for (const listener of listeners) {
    try {
      listener(sessionIds)
    } catch (error) {
      onError(error)
    }
  }
}
