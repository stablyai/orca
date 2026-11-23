// An ACP agent's bot tools reach it as the `mcpServers` of the session it opens or reopens, sent over
// stdin, so they need no folder trust or config file, and a session started anywhere else never sees them.
import type { McpServer } from '../acp/generated/acp-protocol.generated'
import { acpMcpServer } from '../acp/launch/acp-mcp-server'
import type { BotLaunchTools } from './bot-launch-tools'

export function acpBotMcpServers(tools: BotLaunchTools): McpServer[] {
  return tools.servers.map(acpMcpServer)
}
