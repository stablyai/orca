type ConnectionRevivalReason = 'app-resume' | 'network-change'

const listeners = new Set<(reason: ConnectionRevivalReason) => void>()

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
