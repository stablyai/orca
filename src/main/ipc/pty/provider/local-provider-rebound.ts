// Layout-owner build: who learns that this machine's terminal provider was installed or replaced
// (a terminal service restart), so main can show the live terminals the new provider reports.

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
