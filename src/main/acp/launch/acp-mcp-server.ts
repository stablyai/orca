import type { McpServer } from '../generated/acp-protocol.generated'

/** An MCP server as a bot or an agent's config file names it. */
export type AcpMcpServerSource =
  | {
      name: string
      url: string
      transport?: 'http' | 'sse'
      headers?: Readonly<Record<string, string>>
    }
  | {
      name: string
      command: string
      args: readonly string[]
      env?: Readonly<Record<string, string>>
    }

const pairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

export function acpMcpServer(server: AcpMcpServerSource): McpServer {
  return 'url' in server
    ? {
        type: server.transport ?? 'http',
        name: server.name,
        url: server.url,
        headers: pairs(server.headers)
      }
    : { name: server.name, command: server.command, args: [...server.args], env: pairs(server.env) }
}
