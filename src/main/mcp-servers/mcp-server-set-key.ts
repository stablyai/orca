import { createHash } from 'node:crypto'

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
 * A short digest of the MCP servers an agent launched with, to tell later whether a kept agent
 * still has the set a launch would give it: any change to a server (its url, command, arguments,
 * environment or headers) changes it, and order doesn't. A relayed server's url carries this run's
 * credential, so it differs every run; such a launch replaces a kept agent anyway.
 */
export function mcpServerSetKey(servers: readonly McpServerIdentity[]): string {
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
  return createHash('sha256').update(JSON.stringify(each)).digest('hex').slice(0, 16)
}
