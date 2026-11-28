// Read-only: the MCP servers each agent loads from its own config, and the "In your agents" list
// that merges them across agents by name and URL or command.
import { createHash } from 'node:crypto'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import {
  agentMcpConfigEntry,
  agentMcpConfigEntryDisabled,
  agentMcpServerMergeKey,
  isOrcaOwnedAgentMcpServer,
  type AgentMcpConfigEntry
} from '../../../shared/mcp/agent-mcp-config-entry'
import type { BotToolServer } from '../../../shared/bot-tools'
import {
  MCP_CONFIG_AGENTS,
  agentMcpConfigLocations,
  agentMcpProjectConfigLocations,
  agentMcpServerBlocks,
  type AgentMcpConfigContext,
  type AgentMcpConfigLocation,
  type AgentMcpServerBlock,
  type McpConfigAgent
} from './agent-mcp-config-locations'
import { readAgentConfigText } from './agent-config-file-write'

export type AgentMcpConfigSource = AgentMcpConfigLocation & {
  /** The key path of the entry itself in the file. */
  keyPath: string[]
  projectPath?: string
  disabled: boolean
}

export type AgentMcpConfigServer = AgentMcpConfigEntry & { source: AgentMcpConfigSource }

/** A name an agent's file holds, whether or not Orca can read its entry. */
export type AgentMcpConfigName = {
  name: string
  scope: AgentMcpConfigLocation['scope']
  /** Claude's per-folder servers in its user file. */
  projectPath?: string
  /** Switched off by a file-wide list (an entry's own flag shows on its server). */
  disabled: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A copy of the object's own keys only, so nothing reads through its prototype. */
function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? Object.fromEntries(Object.entries(value)) : null
}

/** The file's parsed top level, or null when it doesn't parse as its format. */
export function parseAgentMcpConfigText(
  text: string,
  format: AgentMcpConfigLocation['format']
): Record<string, unknown> | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (format === 'toml') {
    try {
      return record(parseToml(body))
    } catch {
      return null
    }
  }
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(body, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return null
  }
  return parsed === undefined ? {} : record(parsed)
}

export function valueAtKeyPath(root: unknown, path: readonly string[]): unknown {
  let value = root
  // Why no copy per step: Claude's projects map holds one entry per folder it ever opened.
  for (const segment of path) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) {
      return undefined
    }
    value = value[segment]
  }
  return value
}

/** Every server in one file's text that Orca can carry; null when the file doesn't parse. */
export function agentMcpConfigServersIn(
  location: AgentMcpConfigLocation,
  text: string,
  skipProject: (projectPath: string) => boolean = () => false,
  withOrcaOwned = false
): AgentMcpConfigServer[] | null {
  const parsed = parseAgentMcpConfigText(text, location.format)
  if (!parsed) {
    return null
  }
  return serversInBlocks(
    location,
    parsed,
    agentMcpServerBlocks(location, parsed, skipProject),
    withOrcaOwned
  )
}

function serversInBlocks(
  location: AgentMcpConfigLocation,
  parsed: Record<string, unknown>,
  blocks: readonly AgentMcpServerBlock[],
  withOrcaOwned: boolean
): AgentMcpConfigServer[] {
  return blocks.flatMap((block) =>
    Object.entries(record(valueAtKeyPath(parsed, block.path)) ?? {}).flatMap(([name, raw]) => {
      const entry = agentMcpConfigEntry(name, raw, block.dialect)
      if (
        !entry ||
        (!withOrcaOwned && isOrcaOwnedAgentMcpServer(entry.server)) ||
        block.restrictedNames?.has(name)
      ) {
        return []
      }
      const source: AgentMcpConfigSource = {
        ...location,
        keyPath: [...block.path, name],
        ...(block.projectPath ? { projectPath: block.projectPath } : {}),
        disabled: entry.disabled || (block.disabledNames?.has(name) ?? false)
      }
      return [{ ...entry, source }]
    })
  )
}

async function readLocationText(location: AgentMcpConfigLocation): Promise<string | null> {
  try {
    // Through the publisher's reader: a config Orca holds aside is waited for or put back.
    return await readAgentConfigText(location.path)
  } catch (error) {
    console.warn(`[mcp-servers] Couldn't read ${location.path}:`, error)
    return null
  }
}

const warnUnparsed = (location: AgentMcpConfigLocation): void =>
  console.warn(`[mcp-servers] ${location.path} doesn't parse; its servers aren't listed`)

async function readLocation(
  location: AgentMcpConfigLocation,
  skipProject?: (projectPath: string) => boolean,
  withOrcaOwned?: boolean
): Promise<AgentMcpConfigServer[]> {
  const text = await readLocationText(location)
  if (text === null) {
    return []
  }
  const servers = agentMcpConfigServersIn(location, text, skipProject, withOrcaOwned)
  if (!servers) {
    warnUnparsed(location)
  }
  return servers ?? []
}

/** The servers the agent's own files in `projectPath`'s repo define; its user files go unread. */
export async function readAgentProjectMcpServers(
  agent: McpConfigAgent,
  projectPath: string
): Promise<AgentMcpConfigServer[]> {
  const read = await Promise.all(
    agentMcpProjectConfigLocations(agent, projectPath).map((location) => readLocation(location))
  )
  return read.flat()
}

/**
 * The servers one agent loads from its own config: its user files, and with `projectPath` that
 * repo's files too. Orca's own bridge entries are left out unless `withOrcaOwned`.
 */
export async function readAgentMcpServers(
  agent: McpConfigAgent,
  context: AgentMcpConfigContext,
  options: {
    projectPath?: string
    skipProject?: (projectPath: string) => boolean
    withOrcaOwned?: boolean
  } = {}
): Promise<AgentMcpConfigServer[]> {
  const locations = await agentMcpConfigLocations(agent, context, options.projectPath)
  const read = await Promise.all(
    locations.map((location) => readLocation(location, options.skipProject, options.withOrcaOwned))
  )
  return read.flat()
}

/**
 * Every server name one agent's config holds, whether or not Orca could carry the entry (a name the
 * agent already uses is taken even when its entry has fields Orca can't read), and the servers it
 * can carry with Orca's own bridge entries, from one read of each file.
 */
export async function readAgentMcpServerNames(
  agent: McpConfigAgent,
  context: AgentMcpConfigContext,
  options: { projectPath?: string; skipProject?: (projectPath: string) => boolean } = {}
): Promise<{
  names: AgentMcpConfigName[]
  servers: AgentMcpConfigServer[]
  /** Names a read folder's block switches off whatever file defines them (Claude's `/mcp disable`). */
  folderDisabled: ReadonlySet<string>
}> {
  const locations = await agentMcpConfigLocations(agent, context, options.projectPath)
  const read = await Promise.all(
    locations.map(async (location) => {
      const text = await readLocationText(location)
      const parsed = text === null ? null : parseAgentMcpConfigText(text, location.format)
      if (!parsed) {
        if (text !== null) {
          warnUnparsed(location)
        }
        return { names: [], servers: [], folderDisabled: [] }
      }
      const blocks = agentMcpServerBlocks(location, parsed, options.skipProject ?? (() => false))
      return {
        names: blocks.flatMap((block) =>
          Object.entries(record(valueAtKeyPath(parsed, block.path)) ?? {}).map(([name, raw]) => ({
            name,
            scope: location.scope,
            ...(block.projectPath ? { projectPath: block.projectPath } : {}),
            // Parsed config is plain data, so its own flags are read in place.
            disabled:
              (block.disabledNames?.has(name) ?? false) ||
              (isRecord(raw) && agentMcpConfigEntryDisabled(raw, block.dialect))
          }))
        ),
        servers: serversInBlocks(location, parsed, blocks, true),
        folderDisabled: blocks.flatMap((block) =>
          block.projectPath ? [...(block.disabledNames ?? [])] : []
        )
      }
    })
  )
  return {
    names: read.flatMap((location) => location.names),
    servers: read.flatMap((location) => location.servers),
    folderDisabled: new Set(read.flatMap((location) => location.folderDisabled))
  }
}

export type DiscoveredAgentMcpServer = {
  /** Opaque and stable while the agents' entries keep their name and URL or command. */
  key: string
  server: BotToolServer
  sources: AgentMcpConfigSource[]
}

const discoveryKey = (mergeKey: string): string =>
  createHash('sha256').update(mergeKey).digest('base64url').slice(0, 22)

/**
 * "In your agents": every agent's user-level servers (Claude's per-project ones included), one row
 * per name and URL or command. The first agent in Orca's order names the row's config.
 */
export async function discoverAgentMcpServers(
  context: AgentMcpConfigContext,
  skipProject: (projectPath: string) => boolean
): Promise<DiscoveredAgentMcpServer[]> {
  const perAgent = await Promise.all(
    MCP_CONFIG_AGENTS.map((agent) => readAgentMcpServers(agent, context, { skipProject }))
  )
  const merged = new Map<string, DiscoveredAgentMcpServer>()
  for (const found of perAgent.flat()) {
    const mergeKey = agentMcpServerMergeKey(found.configName, found.server)
    const row = merged.get(mergeKey)
    if (row) {
      row.sources.push(found.source)
    } else {
      merged.set(mergeKey, {
        key: discoveryKey(mergeKey),
        server: found.server,
        sources: [found.source]
      })
    }
  }
  return [...merged.values()]
}
