// OMP's ACP mode skips its own MCP config and connects only the servers the client sends, so a chat
// sends the ones its native mcp.json files define, read as OMP's terminal reads them.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasReachedAppVersion } from '../../shared/app-lifecycle/identity/app-version'
import type { McpServer } from '../acp/generated/acp-protocol.generated'
import type { AcpOwnMcpServersLoader } from '../acp/launch/acp-launch-contract'
import { acpMcpServer, type AcpMcpServerSource } from '../acp/launch/acp-mcp-server'

// Before 18.12.6 one server failing to connect fails session/new, so the chat would not open.
const OMP_TOLERATES_FAILED_MCP_SERVERS = '18.12.6'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    })
  )
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return {}
  }
}

/** OMP's `${VAR}` and `${VAR:-default}`; an unset plain `${VAR}` stays literal. */
function expandEnv(value: unknown, env: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([^}:]+)(?::-([^}]*))?\}/g,
      (match, name: string, fallback?: string) => {
        const found = Object.hasOwn(env, name) ? env[name] : undefined
        if (found !== undefined && (fallback === undefined || found !== '')) {
          return found
        }
        return fallback ?? match
      }
    )
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnv(item, env))
  }
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item, env)]))
    : value
}

function ompServerSource(name: string, entry: Record<string, unknown>): AcpMcpServerSource | null {
  const { command, url, type } = entry
  if (typeof command === 'string' && command && (type === undefined || type === 'stdio')) {
    return { name, command, args: strings(entry.args), env: stringRecord(entry.env) }
  }
  if (typeof url === 'string' && url && (type === undefined || type === 'http' || type === 'sse')) {
    return { name, url, transport: type ?? 'http', headers: stringRecord(entry.headers) }
  }
  return null
}

export const readOmpMcpServers: AcpOwnMcpServersLoader = async ({ cwd, env, version }) => {
  const agentDir = env.PI_CODING_AGENT_DIR
  if (
    !agentDir ||
    version === null ||
    !hasReachedAppVersion(version, OMP_TOLERATES_FAILED_MCP_SERVERS)
  ) {
    return []
  }
  // OMP's order: project files before user files, and the first entry of a name owns it.
  const [projectMain, projectDot, user, userDot] = await Promise.all(
    [
      join(cwd, '.omp', 'mcp.json'),
      join(cwd, '.omp', '.mcp.json'),
      join(agentDir, 'mcp.json'),
      join(agentDir, '.mcp.json')
    ].map(readJsonObject)
  )
  const disabled = new Set(strings(user.disabledServers))
  const forced = new Set(strings(user.enabledServers))
  const claimed = new Set<string>()
  const servers: McpServer[] = []
  for (const file of [projectMain, projectDot, user, userDot]) {
    for (const [name, raw] of Object.entries(record(file.mcpServers))) {
      if (claimed.has(name)) {
        continue
      }
      claimed.add(name)
      const entry = record(expandEnv(raw, env))
      if (disabled.has(name) || (entry.enabled === false && !forced.has(name))) {
        continue
      }
      const source = ompServerSource(name, entry)
      if (source) {
        servers.push(acpMcpServer(source))
      }
    }
  }
  return servers
}
