import type { BridgeTerminalKeyId } from './bridge-terminal-key'

/**
 * Who in this document holds the shell's key rail, and hears its presses: the session screen's
 * command dock, while it shows a terminal. The shell is told on each edge and again on each `init`,
 * because it forgets the claim whenever a document starts.
 */
export function createBridgeClientTerminalKeys(publishClaim: (claimed: boolean) => void) {
  const listeners = new Set<(key: BridgeTerminalKeyId) => void>()
  return {
    accept: (key: BridgeTerminalKeyId) => {
      for (const listener of listeners) {
        listener(key)
      }
    },
    /** Claims the rail until the dispose is called; `listener` takes each press meanwhile. */
    claim: (listener: (key: BridgeTerminalKeyId) => void) => {
      // A fresh wrapper, so the same function claiming twice holds two claims.
      const entry = (key: BridgeTerminalKeyId) => listener(key)
      listeners.add(entry)
      if (listeners.size === 1) {
        publishClaim(true)
      }
      return () => {
        if (listeners.delete(entry) && listeners.size === 0) {
          publishClaim(false)
        }
      }
    },
    reassert: () => {
      if (listeners.size > 0) {
        publishClaim(true)
      }
    }
  }
}
