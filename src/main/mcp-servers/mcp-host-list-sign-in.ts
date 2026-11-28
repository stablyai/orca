// Orca's own sign-in to a server in the host's list: which one it has, signing out of it, and
// telling clients when one changes outside an mcpServers.* call.
import { resolve } from 'node:path'
import type { McpServer } from '../../shared/mcp-servers/mcp-servers'
import { botToolSignInUnreadable } from '../../shared/bot-tool-sign-in'
import {
  botToolCredentialsReader,
  botToolCredentialsTransaction,
  commitBotToolOAuth
} from '../bots/bot-tool-credentials'
import { onBotToolSignInChanged } from '../bots/bot-tool-sign-in-changed'
import {
  BotToolSignInError,
  discoveryOptions,
  type BotToolOAuthKey
} from '../bots/tool-oauth/bot-tool-oauth'
import { discoverBotToolAuth } from '../bots/tool-oauth/bot-tool-oauth-discovery'
import { signOutBotTool } from '../bots/tool-oauth/bot-tool-oauth-revoke'
import { entryById, storedView } from './mcp-host-list'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { McpServersError } from './mcp-servers-error'
import { isMcpServersFeatureEnabled } from './mcp-servers-feature'

export const noSignIn = (): McpServersError =>
  new McpServersError('mcp_server_no_sign_in', 'Orca doesn’t sign in to this server.')

/**
 * The server's sign-in, when Orca signs in to it. `starting`: a new sign-in starts on it, so a saved
 * entry that doesn't open here (a reset keychain) is replaced with a signed-out sign-in, but only
 * when the address asks for one: a key server keeps its entry for Edit. Throws
 * `BotToolSignInError` when the address can't be signed in to.
 */
export async function mcpServerSignInKey(
  id: string,
  folder = mcpHostListFolder(),
  starting?: { signal?: AbortSignal }
): Promise<BotToolOAuthKey | null> {
  const { server } = await entryById(folder, id)
  const credentialId = 'url' in server ? server.credential : undefined
  if (!('url' in server) || !credentialId) {
    return null
  }
  const key = { folder, credentialId }
  const stored = botToolCredentialsReader(folder)
  if (stored.oauth(credentialId)) {
    return key
  }
  if (!starting || !stored.unreadable(credentialId)) {
    return null
  }
  const need = await discoverBotToolAuth(server.url, discoveryOptions(starting.signal))
  if (need.kind !== 'oauth') {
    throw new BotToolSignInError(need.kind === 'unavailable' ? 'unavailable' : 'unsupported')
  }
  const url = server.url
  const replaced = await botToolCredentialsTransaction(folder, () =>
    commitBotToolOAuth(folder, credentialId, () => ({ url, grant: 0, record: { resource: url } }), {
      replaceUnreadable: true
    })
  )
  // Not replaced: it opens again, or went, since it was read; the next press reads it afresh.
  return replaced ? key : null
}

/** Signs Orca out of the server: its tokens are revoked, and its row reads signed out, ready to sign in again. */
export async function signOutMcpServer(
  id: string,
  folder = mcpHostListFolder()
): Promise<McpServer> {
  const key = await mcpServerSignInKey(id, folder)
  if (key) {
    await signOutBotTool(key)
  }
  const view = await storedView(folder, id)
  // One whose saved entry doesn't open here has no sign-in to end; an older phone still offers it.
  if (!key && !botToolSignInUnreadable(view.signIn)) {
    throw noSignIn()
  }
  return view
}

/** Calls `changed` when a sign-in in the host's list changes what its row shows, while the switch is on. */
export function onMcpHostListSignInChanged(changed: () => void): () => void {
  return onBotToolSignInChanged((folder) => {
    if (isMcpServersFeatureEnabled() && folder === resolve(mcpHostListFolder())) {
      changed()
    }
  })
}
