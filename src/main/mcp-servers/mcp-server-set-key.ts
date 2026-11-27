import { createHmac } from 'node:crypto'
import { mcpServerSetKeySecret } from './mcp-server-set-key-secret'

/** The fields that say which MCP server an agent was given; providers' own shapes fit it. */
export type McpServerIdentity = {
  name: string
  url?: string
  type?: string
  command?: string
  args?: readonly string[]
  env?: unknown
  headers?: unknown
}

/**
 * A short keyed digest of the MCP servers an agent launched with, to tell later whether a kept
 * agent still has the set a launch would give it: any change to a server (its url, command,
 * arguments, environment or headers) changes it, and order doesn't. It's an HMAC under this
 * install's secret, so no stored key lets a value in it be guessed. A relayed server's url carries
 * this run's credential, so it differs every run; such a launch replaces a kept agent anyway.
 */
export async function mcpServerSetKey(
  servers: readonly McpServerIdentity[],
  secret: Promise<Buffer> = mcpServerSetKeySecret()
): Promise<string> {
  // No servers hold nothing to guess, so the empty set keeps one key across runs and installs.
  if (servers.length === 0) {
    return 'none'
  }
  const each = servers
    .map((server) =>
      JSON.stringify([
        server.name,
        server.url ?? null,
        server.type ?? null,
        server.command ?? null,
        server.args ?? [],
        server.env ?? null,
        server.headers ?? null
      ])
    )
    .sort()
  return createHmac('sha256', await secret)
    .update(JSON.stringify(each))
    .digest('hex')
    .slice(0, 16)
}
