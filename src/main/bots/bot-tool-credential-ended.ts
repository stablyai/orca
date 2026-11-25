// Tells the relay a bot credential ended (removed, or its sign-in replaced or signed out), so calls
// still open through it are cut.
import { resolve } from 'node:path'

/** A credential that ended: removed, or its sign-in replaced or signed out. */
export type BotToolCredentialEnded = { folder: string; credentialId: string }
const endedListeners = new Set<(ended: BotToolCredentialEnded) => void>()

/** Calls `listener` after each credential ends, so open calls through it can be cut. */
export function onBotToolCredentialEnded(
  listener: (ended: BotToolCredentialEnded) => void
): () => void {
  endedListeners.add(listener)
  return () => endedListeners.delete(listener)
}

export function announceBotToolCredentialsEnded(folder: string, ids: Iterable<string>): void {
  for (const credentialId of ids) {
    for (const listener of endedListeners) {
      try {
        listener({ folder: resolve(folder), credentialId })
      } catch (error) {
        console.warn('[bot-tool-credentials] an ended-credential listener failed:', error)
      }
    }
  }
}
