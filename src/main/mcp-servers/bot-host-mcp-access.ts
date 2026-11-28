// A bot's reach to its host's MCP list, kept apart from the list's reader so the bots' own tool
// checks can ask without loading it.
import { mcpHostListFolder } from './mcp-host-list-folder'
import { isMcpServersFeatureEnabled } from './mcp-servers-feature'
import type { SessionHostMcpServers } from './session-mcp-tools'

/**
 * The host list a bot's token may reach while it opts in and the switch is on, with none of its
 * servers: Orca's own checks of the bot's tools grant its token again and must keep that access.
 */
export function botHostMcpAccess(
  hostMcpServers: boolean,
  folder?: string
): SessionHostMcpServers | undefined {
  return hostMcpServers && isMcpServersFeatureEnabled()
    ? { folder: folder ?? mcpHostListFolder(), servers: [] }
    : undefined
}
