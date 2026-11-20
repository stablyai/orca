// OMP's ACP mode skips its own MCP config and connects only the servers the client sends, so a chat
// sends the ones its native mcp.json files define, read as OMP's terminal reads them.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { hasReachedAppVersion } from '../../shared/app-lifecycle/identity/app-version'
import { normalizedOmpProfile } from '../../shared/agent-launch/startup/omp-profile'
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

async function readObject(
  paths: readonly string[],
  parse: (text: string) => unknown
): Promise<Record<string, unknown>> {
  for (const path of paths) {
    try {
      return record(parse(await readFile(path, 'utf8')))
    } catch {
      // Missing or malformed: OMP skips it too.
    }
  }
  return {}
}

const readJsonObject = (path: string) => readObject([path], JSON.parse)

/** OMP takes a named profile's folder, under its own home, over PI_CODING_AGENT_DIR. */
function ompAgentDir(env: Readonly<Record<string, string>>): string | undefined {
  const profile = normalizedOmpProfile(env.OMP_PROFILE ?? env.PI_PROFILE)
  return profile
    ? join(
        (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir(),
        env.PI_CONFIG_DIR || '.omp',
        'profiles',
        profile,
        'agent'
      )
    : env.PI_CODING_AGENT_DIR
}

/** OMP's string forms of `enabled`; anything else counts as unset. */
function ompFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  const text = typeof value === 'string' ? value.toLowerCase() : null
  return text === 'true' || text === '1'
    ? true
    : text === 'false' || text === '0'
      ? false
      : undefined
}

// Windows names are case-insensitive (`Path`), as in OMP's own environment.
function envValue(env: Readonly<Record<string, string>>, name: string): string | undefined {
  if (process.platform !== 'win32') {
    return Object.hasOwn(env, name) ? env[name] : undefined
  }
  const upper = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === upper)?.[1]
}

/** OMP's `${VAR}` and `${VAR:-default}`; an unset plain `${VAR}` stays literal. */
function expandEnv(value: unknown, env: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([^}:]+)(?::-([^}]*))?\}/g,
      (match, name: string, fallback?: string) => {
        const found = envValue(env, name)
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
  // ACP has no working directory for a server, which would then start in the chat's folder.
  if (entry.cwd !== undefined) {
    return null
  }
  if (typeof command === 'string' && command && (type === undefined || type === 'stdio')) {
    return { name, command, args: strings(entry.args), env: stringRecord(entry.env) }
  }
  if (typeof url === 'string' && url && (type === undefined || type === 'http' || type === 'sse')) {
    return { name, url, transport: type ?? 'http', headers: stringRecord(entry.headers) }
  }
  return null
}

export const readOmpMcpServers: AcpOwnMcpServersLoader = async ({ cwd, env, version }) => {
  const agentDir = ompAgentDir(env)
  if (
    !agentDir ||
    version === null ||
    !hasReachedAppVersion(version, OMP_TOLERATES_FAILED_MCP_SERVERS)
  ) {
    return []
  }
  const [settings, user, userDot, ...project] = await Promise.all([
    readObject([join(agentDir, 'config.yml'), join(agentDir, 'config.yaml')], parseYaml),
    readJsonObject(join(agentDir, 'mcp.json')),
    readJsonObject(join(agentDir, '.mcp.json')),
    readJsonObject(join(cwd, '.omp', 'mcp.json')),
    readJsonObject(join(cwd, '.omp', '.mcp.json'))
  ])
  if (strings(settings.disabledProviders).includes('native')) {
    return []
  }
  const disabledExtensions = new Set(strings(settings.disabledExtensions))
  const projectEnabled =
    (record(settings.mcp).enableProjectConfig ?? settings['mcp.enableProjectConfig']) !== false
  const disabled = new Set(strings(user.disabledServers))
  const forced = new Set(strings(user.enabledServers))
  // OMP points PI_CODING_AGENT_DIR at a named profile's folder before it reads these files.
  const expansionEnv = { ...env, PI_CODING_AGENT_DIR: agentDir }
  const claimed = new Set<string>()
  const servers: McpServer[] = []
  // OMP's order: project files before user files, and the first entry of a name owns it.
  for (const file of [...(projectEnabled ? project : []), user, userDot]) {
    for (const [name, raw] of Object.entries(record(file.mcpServers))) {
      if (claimed.has(name) || disabledExtensions.has(`mcp:${name}`)) {
        continue
      }
      claimed.add(name)
      const entry = record(expandEnv(raw, expansionEnv))
      if (disabled.has(name) || (ompFlag(entry.enabled) === false && !forced.has(name))) {
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
