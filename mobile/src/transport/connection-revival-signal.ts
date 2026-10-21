type ConnectionRevivalReason = 'app-resume' | 'network-change'

const listeners = new Set<(reason: ConnectionRevivalReason) => void>()

/** Hears each OS signal that the link may be back, as client-context relays it to live clients. */
export function subscribeConnectionRevival(
  listener: (reason: ConnectionRevivalReason) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishConnectionRevival(reason: ConnectionRevivalReason): void {
  for (const listener of listeners) {
    listener(reason)
  }
}
