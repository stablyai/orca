// A stored tool as its editor starts from: the saved values put back, or its sign-in's id kept.
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import type { BotToolServer } from '../../shared/bot-tools'
import { readBotToolCredential, readBotToolOAuth } from './bot-tool-credentials'

/**
 * A stored tool as an edit starts from: its saved values and the address they're bound to, and a
 * credential id only for Orca's own sign-in, which the edit keeps.
 */
export function withSavedBotToolHeaders(folder: string, server: BotToolServer): BotToolServer {
  if (!('url' in server) || !server.credential) {
    return server
  }
  if (readBotToolOAuth(folder, server.credential)) {
    // Its tokens are Orca's own sign-in; a generic edit keeps the id and changes no values.
    return server
  }
  const { credential, ...rest } = server
  const saved = readBotToolCredential(folder, credential)
  if (saved?.source) {
    // Its headers come from a source Orca fills per call; a generic edit would drop them.
    throw new BotFailureError('toolSourceManaged')
  }
  return saved ? { ...rest, url: saved.url, headers: saved.headers } : rest
}
