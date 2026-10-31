/** An unproven whole-tab close stops holding a process's output: every view holding it resyncs now, not on its next write. */
const listenersByPtyId = new Map<string, Set<() => void>>()

export function subscribeToPtyPresentationRelease(ptyId: string, listener: () => void): () => void {
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

export function publishPtyPresentationRelease(ptyId: string): void {
  const listeners = listenersByPtyId.get(ptyId)
  if (!listeners) {
    return
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[terminal] presentation release listener failed:', error)
    }
  }
}
