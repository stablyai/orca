// An ACP agent's bot tools reach it as the `mcpServers` of the session it opens or reopens, sent over
// stdin, so they need no folder trust or config file, and a session started anywhere else never sees them.
import type { McpServer } from '../acp/generated/acp-protocol.generated'
import type { BotLaunchTools } from './bot-launch-tools'

const pairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

export function acpBotMcpServers(tools: BotLaunchTools): McpServer[] {
  return tools.servers.map((server) =>
    'url' in server
      ? { type: 'http', name: server.name, url: server.url, headers: pairs(server.headers) }
      : { name: server.name, command: server.command, args: server.args, env: pairs(server.env) }
  )
}
