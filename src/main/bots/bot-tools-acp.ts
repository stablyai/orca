// An ACP agent's bot tools reach it as the `mcpServers` of the session it opens or reopens, sent over
// stdin, so they need no folder trust or config file, and a session started anywhere else never sees them.
import type { McpServer } from '../acp/generated/acp-protocol.generated'
import { acpMcpServer } from '../acp/launch/acp-mcp-server'
import type { SessionMcpTools } from '../mcp-servers/session-mcp-tools'
import { mcpServerSetKey } from '../mcp-servers/mcp-server-set-key'

export function acpBotMcpServers(tools: SessionMcpTools): McpServer[] {
  return tools.servers.map(acpMcpServer)
}

/** A launch's servers: Orca's (none when its tools are off) beside the agent's own, Orca's winning
 *  a shared name. `toolsKey` keys only Orca's; none when the agent's own couldn't be read (`ownRead`
 *  false: their names decide which of Orca's it gets), so no launch compares an unknown set. */
export async function acpLaunchServers(
  tools: SessionMcpTools,
  own: readonly McpServer[],
  toolsOff: unknown,
  ownRead: boolean
): Promise<{ mcpServers: McpServer[]; toolsKey?: string }> {
  const orca = toolsOff ? [] : acpBotMcpServers(tools)
  const mcpServers = [...orca, ...own.filter((one) => !orca.some((bot) => bot.name === one.name))]
  return { mcpServers, ...(ownRead ? { toolsKey: await mcpServerSetKey(orca) } : {}) }
}
