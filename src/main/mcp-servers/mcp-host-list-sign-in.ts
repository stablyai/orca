// Orca's own sign-in to a server in the host's list: which one it has, signing out of it, and
// telling clients when one changes outside an mcpServers.* call.
import { resolve } from 'node:path'
import type { McpServer } from '../../shared/mcp-servers/mcp-servers'
import { readBotToolOAuth } from '../bots/bot-tool-credentials'
import { onBotToolSignInChanged } from '../bots/bot-tool-sign-in-changed'
import type { BotToolOAuthKey } from '../bots/tool-oauth/bot-tool-oauth'
import { signOutBotTool } from '../bots/tool-oauth/bot-tool-oauth-revoke'
import { entryById, mcpHostListFolder, storedView } from './mcp-host-list'
import { McpServersError } from './mcp-servers-error'
import { isMcpServersFeatureEnabled } from './mcp-servers-feature'

export const noSignIn = (): McpServersError =>
  new McpServersError('mcp_server_no_sign_in', 'Orca doesn’t sign in to this server.')

/** The server's sign-in, when Orca signs in to it. */
export async function mcpServerSignInKey(
  id: string,
  folder = mcpHostListFolder()
): Promise<BotToolOAuthKey | null> {
  const { server } = await entryById(folder, id)
  return 'url' in server && server.credential && readBotToolOAuth(folder, server.credential)
    ? { folder, credentialId: server.credential }
    : null
}

/** Signs Orca out of the server: its tokens are revoked, and its row reads signed out, ready to sign in again. */
export async function signOutMcpServer(
  id: string,
  folder = mcpHostListFolder()
): Promise<McpServer> {
  const key = await mcpServerSignInKey(id, folder)
  if (!key) {
    throw noSignIn()
  }
  await signOutBotTool(key)
  return storedView(folder, id)
}

/** Calls `changed` when a sign-in in the host's list changes what its row shows, while the switch is on. */
export function onMcpHostListSignInChanged(changed: () => void): () => void {
  return onBotToolSignInChanged((folder) => {
    if (isMcpServersFeatureEnabled() && folder === resolve(mcpHostListFolder())) {
      changed()
    }
  })
}
