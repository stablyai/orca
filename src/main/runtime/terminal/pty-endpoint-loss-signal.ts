/** Fan local provider endpoint loss to remote streams too, so headless clients learn daemon death before trying to type. */
const listenersByPtyId = new Map<string, Set<() => void>>()

export function subscribeToPtyEndpointLoss(ptyId: string, listener: () => void): () => void {
  let listeners = listenersByPtyId.get(ptyId)
  if (!listeners) {
    listeners = new Set()
    listenersByPtyId.set(ptyId, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = listenersByPtyId.get(ptyId)
    current?.delete(listener)
    if (current?.size === 0) {
      listenersByPtyId.delete(ptyId)
    }
  }
}

export function publishPtyEndpointLoss(ptyId: string): void {
  const listeners = listenersByPtyId.get(ptyId)
  if (!listeners) {
    return
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[terminal] endpoint loss listener failed:', error)
    }
  }
}
