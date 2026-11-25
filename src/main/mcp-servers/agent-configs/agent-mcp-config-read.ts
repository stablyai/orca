// Read-only: the MCP servers each agent loads from its own config, and the "In your agents" list
// that merges them across agents by name and URL or command.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import {
  agentMcpConfigEntry,
  agentMcpServerMergeKey,
  isOrcaOwnedAgentMcpServer,
  type AgentMcpConfigEntry
} from '../../../shared/mcp/agent-mcp-config-entry'
import type { BotToolServer } from '../../../shared/bot-tools'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import {
  MCP_CONFIG_AGENTS,
  agentMcpConfigLocations,
  agentMcpServerBlocks,
  type AgentMcpConfigContext,
  type AgentMcpConfigLocation,
  type McpConfigAgent
} from './agent-mcp-config-locations'

export type AgentMcpConfigSource = AgentMcpConfigLocation & {
  /** The key path of the entry itself in the file. */
  keyPath: string[]
  projectPath?: string
  disabled: boolean
}

export type AgentMcpConfigServer = AgentMcpConfigEntry & { source: AgentMcpConfigSource }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** The file's parsed top level, or null when it doesn't parse as its format. */
export function parseAgentMcpConfigText(
  text: string,
  format: AgentMcpConfigLocation['format']
): Record<string, unknown> | null {
  const body = text.replace(/^﻿/, '')
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
  for (const segment of path) {
    const parent = record(value)
    if (!parent || !Object.hasOwn(parent, segment)) {
      return undefined
    }
    value = parent[segment]
  }
  return value
}

/** Every server in one file's text that Orca can carry; null when the file doesn't parse. */
export function agentMcpConfigServersIn(
  location: AgentMcpConfigLocation,
  text: string,
  skipProject: (projectPath: string) => boolean = () => false
): AgentMcpConfigServer[] | null {
  const parsed = parseAgentMcpConfigText(text, location.format)
  if (!parsed) {
    return null
  }
  return agentMcpServerBlocks(location, parsed, skipProject).flatMap((block) =>
    Object.entries(record(valueAtKeyPath(parsed, block.path)) ?? {}).flatMap(([name, raw]) => {
      const entry = agentMcpConfigEntry(name, raw, block.dialect)
      if (!entry || isOrcaOwnedAgentMcpServer(entry.server)) {
        return []
      }
      const source: AgentMcpConfigSource = {
        ...location,
        keyPath: [...block.path, name],
        ...(block.projectPath ? { projectPath: block.projectPath } : {}),
        disabled: entry.disabled
      }
      return [{ ...entry, source }]
    })
  )
}

async function readLocation(
  location: AgentMcpConfigLocation,
  skipProject?: (projectPath: string) => boolean
): Promise<AgentMcpConfigServer[]> {
  let text: string
  try {
    text = await readFile(location.path, 'utf8')
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      console.warn(`[mcp-servers] Couldn't read ${location.path}:`, error)
    }
    return []
  }
  const servers = agentMcpConfigServersIn(location, text, skipProject)
  if (!servers) {
    console.warn(`[mcp-servers] ${location.path} doesn't parse; its servers aren't listed`)
  }
  return servers ?? []
}

/**
 * The servers one agent loads from its own config: its user files, and with `projectPath` that
 * repo's files too. Orca's own bridge entries are left out.
 */
export async function readAgentMcpServers(
  agent: McpConfigAgent,
  context: AgentMcpConfigContext,
  options: { projectPath?: string; skipProject?: (projectPath: string) => boolean } = {}
): Promise<AgentMcpConfigServer[]> {
  const locations = agentMcpConfigLocations(agent, context, options.projectPath)
  const read = await Promise.all(
    locations.map((location) => readLocation(location, options.skipProject))
  )
  return read.flat()
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
