// The web build of the native app has no device store, so a server's listing lives only in memory there.
import type { KeptServerBotStore } from './kept-server-bot-store'

export async function keptServerBotStore(): Promise<KeptServerBotStore | null> {
  return null
}
