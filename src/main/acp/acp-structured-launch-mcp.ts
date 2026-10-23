// The MCP servers an ACP launch passes to its agent. ACP agents own no MCP config of their own:
// the client supplies the servers each session starts with (`session/new.mcpServers`), so Orca
// reads the workspace's `.mcp.json` at every launch and maps the enabled servers into the request.
// Best effort: an unreadable or invalid config starts the session with no servers. The values here
// reach the agent, so they are read raw — the shared MCP inspection masks env values for display.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MCP_CONFIG_INSPECTION_MAX_SERVERS } from '../../shared/mcp-config-inspection-limits'
import type { EnvVariable, HttpHeader, McpServer } from './generated/acp-protocol.generated'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const WORKSPACE_MCP_CONFIG = '.mcp.json'

/** The MCP transports this agent advertised in initialize; stdio needs no advertisement. */
export type AcpMcpTransportCapabilities = { http: boolean; sse: boolean }

/** The servers this agent can run: remote transports the agent never advertised are dropped with a
 *  warning, so a strict agent's start cannot fail on a transport it does not know. */
export function filterAcpMcpServersByCapabilities(
  servers: readonly McpServer[],
  capabilities: AcpMcpTransportCapabilities,
  logger?: StructuredAgentSessionLogger
): McpServer[] {
  const supported = servers.filter((server) => {
    if (!('type' in server)) {
      return true
    }
    return server.type === 'http' ? capabilities.http : capabilities.sse
  })
  if (supported.length !== servers.length) {
    const dropped = servers.length - supported.length
    logger?.warn('Agent does not advertise the transport of some workspace MCP servers; dropped', {
      scope: 'acp-launch-mcp',
      dropped
    })
  }
  return supported
}

/** One JSON entry's header/env map as the protocol's name-value pairs; an invalid map warns and
 *  yields none, so one bad entry cannot fail the workspace's other servers. */
function nameValuePairs(
  raw: unknown,
  server: string,
  field: string,
  logger: StructuredAgentSessionLogger | undefined
): { name: string; value: string }[] {
  if (raw === undefined || raw === null) {
    return []
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger?.warn('Workspace MCP server field is not an object; dropping it', {
      scope: 'acp-launch-mcp',
      server,
      field
    })
    return []
  }
  const pairs: { name: string; value: string }[] = []
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      logger?.warn('Workspace MCP server field value is not a string; dropping the entry', {
        scope: 'acp-launch-mcp',
        server,
        field,
        entry: name
      })
      continue
    }
    pairs.push({ name, value })
  }
  return pairs
}

/** One config entry as the session start names it; null skips an entry Orca cannot map. */
function toAcpMcpServer(
  name: string,
  raw: unknown,
  logger: StructuredAgentSessionLogger | undefined
): McpServer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logger?.warn('Workspace MCP server entry is not an object; skipping it', {
      scope: 'acp-launch-mcp',
      server: name
    })
    return null
  }
  const entry = raw as Record<string, unknown>
  if (entry.enabled === false || entry.disabled === true) {
    return null
  }
  if (typeof entry.command === 'string' && entry.command.length > 0) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    return {
      name,
      command: entry.command,
      args,
      env: nameValuePairs(entry.env, name, 'env', logger) as EnvVariable[]
    }
  }
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    if (entry.type === 'sse') {
      return {
        type: 'sse',
        name,
        url: entry.url,
        headers: nameValuePairs(entry.headers, name, 'headers', logger) as HttpHeader[]
      }
    }
    return {
      type: 'http',
      name,
      url: entry.url,
      headers: nameValuePairs(entry.headers, name, 'headers', logger) as HttpHeader[]
    }
  }
  logger?.warn('Workspace MCP server entry names no command or URL; skipping it', {
    scope: 'acp-launch-mcp',
    server: name
  })
  return null
}

/** The workspace `.mcp.json`'s enabled servers as the session start names them; never throws. A
 *  workspace whose folder Orca does not pre-trust starts no servers: the config is the workspace's,
 *  so passing it to the agent rides on the same trust that runs the workspace's hooks and settings
 *  (`agentWorkspaceTrustEnabled`); off, each agent asks for the folder itself, and MCP rides along
 *  only once the folder is trusted. */
export async function resolveAcpLaunchMcpServers(
  cwd: string,
  logger?: StructuredAgentSessionLogger,
  trusted: () => boolean = () => true
): Promise<McpServer[]> {
  if (!trusted()) {
    return []
  }
  let content: string
  try {
    content = await readFile(join(cwd, WORKSPACE_MCP_CONFIG), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    logger?.warn('Workspace MCP config is not valid JSON; continuing without it', {
      scope: 'acp-launch-mcp',
      path: WORKSPACE_MCP_CONFIG,
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
  const rawServers =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)['mcpServers']
      : null
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    return []
  }
  const servers: McpServer[] = []
  for (const [name, raw] of Object.entries(rawServers as Record<string, unknown>)) {
    if (servers.length >= MCP_CONFIG_INSPECTION_MAX_SERVERS) {
      logger?.warn('Workspace MCP config exceeds the server limit; the rest are skipped', {
        scope: 'acp-launch-mcp',
        limit: MCP_CONFIG_INSPECTION_MAX_SERVERS
      })
      break
    }
    const server = toAcpMcpServer(name, raw, logger)
    if (server) {
      servers.push(server)
    }
  }
  return servers
}
