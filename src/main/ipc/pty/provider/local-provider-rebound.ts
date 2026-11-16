// Main-owned layout discovers surviving terminals whenever the local provider is installed or replaced.

type ReboundListener = () => void

const listeners = new Set<ReboundListener>()

export function onLocalPtyProviderRebound(listener: ReboundListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyLocalPtyProviderRebound(): void {
  for (const listener of listeners) {
    // One listener's failure never stops the rest or the rebind that called it.
    try {
      listener()
    } catch (error) {
      console.warn('[pty] provider rebound listener failed:', error)
    }
  }
}
