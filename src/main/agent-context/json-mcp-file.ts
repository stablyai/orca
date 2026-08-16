import { inspectMcpConfigContent, type McpConfigInspection } from '../../shared/mcp-config'
import { isMcpConfigInspectionTextWithinLimit } from '../../shared/mcp-config-inspection-limits'
import type { McpFileSource } from './agent-config-file-sources'

function pluckObject(value: unknown, pathSegments: readonly string[]): unknown {
  let current = value
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setObject(
  target: Record<string, unknown>,
  pathSegments: readonly string[],
  value: unknown
): void {
  let current = target
  pathSegments.slice(0, -1).forEach((segment) => {
    const next = current[segment]
    if (!next || typeof next !== 'object') {
      current[segment] = {}
    }
    current = current[segment] as Record<string, unknown>
  })
  current[pathSegments.at(-1) as string] = value
}

/**
 * `~/.claude.json` is Claude's whole client state — project histories, caches,
 * onboarding flags — and routinely outgrows the shared MCP text limit. Only the
 * server objects are inspected, so keep just those and let the shared limits
 * judge what is actually a server collection.
 */
function narrowToServerPaths(content: string, paths: readonly (readonly string[])[]): string {
  if (isMcpConfigInspectionTextWithinLimit(content)) {
    return content
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return content
  }
  const narrowed: Record<string, unknown> = {}
  for (const serversPath of paths) {
    const value = pluckObject(parsed, serversPath)
    if (value !== undefined) {
      setObject(narrowed, serversPath, value)
    }
  }
  return JSON.stringify(narrowed)
}

/**
 * Merges servers from every configured object path. Later paths are the more
 * specific ones (Claude's project-local scope), and a name that appears in a
 * more specific scope shadows the broader one — the same rule Claude applies.
 */
export function inspectJsonMcpFile(
  source: McpFileSource,
  content: string | null
): McpConfigInspection {
  const extraPaths = source.extraServersPaths ?? []
  const narrowed =
    content === null
      ? null
      : narrowToServerPaths(content, [source.candidate.serversPath, ...extraPaths])
  const primary = inspectMcpConfigContent(source.candidate, narrowed)
  if (extraPaths.length === 0 || primary.status !== 'valid') {
    return primary
  }
  const byName = new Map(primary.servers.map((server) => [server.name, server]))
  for (const serversPath of extraPaths) {
    const extra = inspectMcpConfigContent({ ...source.candidate, serversPath }, narrowed)
    for (const server of extra.servers) {
      byName.set(server.name, server)
    }
  }
  return { ...primary, servers: [...byName.values()] }
}
