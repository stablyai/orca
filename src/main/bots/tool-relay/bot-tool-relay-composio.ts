// The relay's header source for Composio apps: the owner's own Composio key.
import { COMPOSIO_SESSION_MCP_URL } from '../../../shared/composio/composio-apps'
import type { BotToolHeaderSource } from '../tool-oauth/bot-tool-credential-source'

/** The owner's current Composio key, read per call so a changed or removed key applies to the next
 *  one; only ever to Composio's own session address, whatever the saved entry names. */
export const composioHeaderSource =
  (readKey: () => string | null | Promise<string | null>): BotToolHeaderSource =>
  async (credential) => {
    if (!COMPOSIO_SESSION_MCP_URL.test(credential.url)) {
      return null
    }
    const key = await readKey()
    return key ? { 'x-api-key': key } : null
  }
