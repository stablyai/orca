// A ZCode bot's own tools reach it as the `mcpServers` of the session it creates or resumes, sent over
// stdin, so they need no folder trust or config file, and a session started anywhere else never sees them.
import type { BotToolServer } from '../../shared/bot-tools'
import type { SessionMcpTools } from '../mcp-servers/session-mcp-tools'

type Pair = { name: string; value: string }

/** An MCP server as ZCode's `session/create` and `session/resume` take it. ZCode refuses any other
 *  key, so the shape is spelled out here rather than borrowed from a looser protocol's. */
export type ZcodeSessionMcpServer =
  | { name: string; command: string; args: string[]; env: Pair[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers: Pair[] }

const pairs = (record: Readonly<Record<string, string>> | undefined): Pair[] =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

export function zcodeSessionMcpServer(server: BotToolServer): ZcodeSessionMcpServer {
  return 'url' in server
    ? {
        type: server.transport ?? 'http',
        name: server.name,
        url: server.url,
        headers: pairs(server.headers)
      }
    : { name: server.name, command: server.command, args: [...server.args], env: pairs(server.env) }
}

export function zcodeBotMcpServers(tools: SessionMcpTools): ZcodeSessionMcpServer[] {
  return tools.servers.map(zcodeSessionMcpServer)
}
