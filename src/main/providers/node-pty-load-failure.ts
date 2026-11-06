/** Told when node-pty fails to load in this process; orcad drops its slot's startup qualification. */
const listeners = new Set<(error: unknown) => void>()

export function onNodePtyLoadFailure(listener: (error: unknown) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function reportNodePtyLoadFailure(error: unknown): void {
  for (const listener of listeners) {
    try {
      listener(error)
    } catch (listenerError) {
      console.warn('[pty] node-pty load-failure listener failed', listenerError)
    }
  }
}
