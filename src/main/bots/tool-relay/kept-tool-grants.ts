// The current bots, for judging the grants a daemon start hands back for the agents it kept, and the
// startup trigger that serves those daemon starts' fronts. Light on purpose: the relay itself loads
// only when a daemon start says it keeps an agent's grants, or a chat launches.
import type { Bot } from '../../../shared/bot-types'
import { botHomeFolder } from '../bot-home'
import { mcpHostListFolder } from '../../mcp-servers/mcp-host-list-folder'
import { MCP_HOST_LIST_RELAY_OWNER, type RelayFolders } from './bot-tool-relay-grants'

export type KeptToolGrantsConfig = {
  /** The current bots; null while they can't be read (a kept grant's own folders are used then). */
  bots: () => readonly Pick<Bot, 'id' | 'folder' | 'hostMcpServers'>[] | null
}

let config: KeptToolGrantsConfig | null = null
let serving: Promise<void> | null = null

/** Desktop startup on macOS and Linux, where agents can outlive the app; elsewhere nothing is kept. */
export function configureKeptToolGrants(installed: KeptToolGrantsConfig): void {
  config = installed
}

/**
 * Each owner's reach from the current config, read once for a whole serve reply: null for a bot
 * that no longer exists, undefined while the bots can't be read.
 */
export function keptGrantOwnerFolders(): (owner: string) => RelayFolders | null | undefined {
  const bots = config?.bots()
  if (!bots) {
    return () => undefined
  }
  const byId = new Map(bots.map((bot) => [bot.id, bot]))
  return (owner) => {
    if (owner === MCP_HOST_LIST_RELAY_OWNER) {
      return { host: mcpHostListFolder() }
    }
    const bot = byId.get(owner)
    if (!bot) {
      return null
    }
    return {
      bot: botHomeFolder(bot),
      ...(bot.hostMcpServers ? { host: mcpHostListFolder() } : {})
    }
  }
}

/** A daemon start keeps some agent's grants: every start's front is served, once per run. */
export function serveKeptToolGrants(): void {
  if (!config) {
    return
  }
  serving ??= import('./bot-tool-relay')
    .then(({ botToolRelay }) => botToolRelay.kept.serveFronts())
    .catch((error: unknown) => {
      serving = null
      console.warn('[bot-tool-relay] kept agents’ fronts could not be served', error)
    })
}
