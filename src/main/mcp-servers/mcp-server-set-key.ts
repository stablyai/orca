import { createHash } from 'node:crypto'

/** The fields that say which MCP server an agent was given; providers' own shapes fit it. */
export type McpServerIdentity = {
  name: string
  url?: string
  command?: string
  args?: readonly string[]
}

/**
 * A short key of the MCP servers an agent launched with, to tell later whether a kept agent still
 * has the set a launch would give it. Order-free. A server reached by url counts only by its name
 * and kind (its url can carry this run's relay credential); a stdio one by its command and args.
 */
export function mcpServerSetKey(servers: readonly McpServerIdentity[]): string {
  const reached = servers
    .map((server) =>
      JSON.stringify(
        server.url !== undefined
          ? [server.name, 'url']
          : [server.name, server.command ?? null, server.args ?? []]
      )
    )
    .sort()
  return createHash('sha256').update(JSON.stringify(reached)).digest('hex').slice(0, 16)
}
