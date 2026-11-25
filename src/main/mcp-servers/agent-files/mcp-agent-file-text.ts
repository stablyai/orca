// Orca's entries in an agent's own MCP file, edited as text so every other byte stays as written.
// Grok's TOML holds them in one marker block per Orca; Cursor's and Droid's JSON can't carry a marker,
// so an entry there is Orca's only while it still holds exactly what Orca wrote (the ledger's copy).
import { isDeepStrictEqual } from 'node:util'
import type { McpFileAgent } from '../../../shared/mcp-servers/mcp-servers'
import {
  agentMcpConfigEntry,
  isOrcaOwnedAgentMcpServer
} from '../../../shared/mcp/agent-mcp-config-entry'
import {
  findManagedTomlBlocks,
  stripManagedTomlRegions,
  type ManagedTomlMarkers
} from '../../agent-hooks/installation/configuration/managed-toml-ownership'
import { escapeTomlBasicString } from '../../codex/configuration/toml/config-toml-syntax'
import { parseAgentMcpConfigText, valueAtKeyPath } from '../agent-configs/agent-mcp-config-read'
import { insertJsonProperty } from '../agent-configs/json-property-insertion'
import { removeJsonProperty } from '../agent-configs/json-property-removal'
import type { McpAgentFileEntry } from './mcp-agent-file-entry'

export type McpAgentFileFormat = 'toml' | 'json'

/** The servers' table in each agent's file. */
const SERVERS_KEY: Record<McpFileAgent, string> = {
  grok: 'mcp_servers',
  cursor: 'mcpServers',
  droid: 'mcpServers'
}

export type McpAgentFileEdit = {
  agent: McpFileAgent
  format: McpAgentFileFormat
  markers: ManagedTomlMarkers
}

/** How the entry is spelled in the agent's file: Droid wants its transport named. */
export function mcpAgentFileValue(
  agent: McpFileAgent,
  entry: McpAgentFileEntry
): Record<string, unknown> {
  return agent === 'droid' ? { type: 'stdio', ...entry } : { ...entry }
}

/** The file's server names; null when the text doesn't parse as its format. */
export function mcpAgentFileServerNames(edit: McpAgentFileEdit, text: string): Set<string> | null {
  const parsed = parseAgentMcpConfigText(text, edit.format)
  if (!parsed) {
    return null
  }
  const servers = valueAtKeyPath(parsed, [SERVERS_KEY[edit.agent]])
  return new Set(
    typeof servers === 'object' && servers !== null && !Array.isArray(servers)
      ? Object.keys(servers)
      : []
  )
}

/** The file's names that hold another Orca's bridge entry (one pinned to another data folder). */
export function otherOrcasServerNames(
  edit: McpAgentFileEdit,
  text: string,
  userDataPath: string
): Set<string> {
  const parsed = parseAgentMcpConfigText(text, edit.format)
  const servers = valueAtKeyPath(parsed, [SERVERS_KEY[edit.agent]])
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return new Set()
  }
  const dialect = edit.format === 'toml' ? 'grok-toml' : 'mcp-json'
  return new Set(
    Object.entries(servers).flatMap(([name, raw]) => {
      const entry = agentMcpConfigEntry(name, raw, dialect)
      const server = entry?.server
      return server &&
        isOrcaOwnedAgentMcpServer(server) &&
        !('url' in server) &&
        server.env?.ORCA_USER_DATA_PATH !== userDataPath
        ? [name]
        : []
    })
  )
}

/**
 * `text` without this Orca's entries: its marker block in TOML; in JSON each entry that still holds
 * what the ledger says Orca wrote (`owned`) or what it would write now (`recognized`), then the
 * servers' table when Orca added it (`addedTable`) and nothing else is left in it.
 */
export function withoutOrcaEntries(
  edit: McpAgentFileEdit,
  text: string,
  owned: Readonly<Record<string, unknown>>,
  recognized: ReadonlyMap<string, unknown>,
  addedTable: boolean
): string {
  if (edit.format === 'toml') {
    const blocks = findManagedTomlBlocks(text, edit.markers).filter((block) => block.terminated)
    return stripManagedTomlRegions(text, blocks).text
  }
  const key = SERVERS_KEY[edit.agent]
  const parsed = parseAgentMcpConfigText(text, 'json')
  const servers = valueAtKeyPath(parsed, [key])
  if (!parsed || typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return text
  }
  let next = text
  for (const [name, value] of Object.entries(servers)) {
    const ours =
      (Object.hasOwn(owned, name) && isDeepStrictEqual(value, owned[name])) ||
      (recognized.has(name) && isDeepStrictEqual(value, recognized.get(name)))
    if (ours) {
      next = removeJsonProperty(next, [key, name])
    }
  }
  if (addedTable && mcpAgentFileServerNames(edit, next)?.size === 0) {
    next = removeJsonProperty(next, [key])
  }
  return next
}

const tomlString = (value: string): string => `"${escapeTomlBasicString(value)}"`

function tomlTable(name: string, entry: McpAgentFileEntry, eol: string): string {
  const env = Object.entries(entry.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ')
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    `env = { ${env} }`
  ].join(eol)
}

/**
 * `base` (null: no file) with `entries` added, by name; entry names are TOML bare keys. Null when the
 * JSON has no object to add them to.
 */
export function withOrcaEntries(
  edit: McpAgentFileEdit,
  base: string | null,
  entries: ReadonlyMap<string, McpAgentFileEntry>
): string | null {
  if (edit.format === 'toml') {
    const text = base ?? ''
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const tables = [...entries].map(([name, entry]) => tomlTable(name, entry, eol))
    const block = [edit.markers.startMarker, tables.join(eol + eol), edit.markers.endMarker].join(
      eol
    )
    const lead = text === '' ? '' : text.endsWith('\n') ? eol : eol + eol
    return `${text}${lead}${block}${eol}`
  }
  const key = SERVERS_KEY[edit.agent]
  const values = [...entries].map(
    ([name, entry]) => [name, mcpAgentFileValue(edit.agent, entry)] as const
  )
  if (base === null) {
    return `${JSON.stringify({ [key]: Object.fromEntries(values) }, null, 2)}\n`
  }
  if (!hasMcpServersTable(edit, base)) {
    return insertJsonProperty(base, [], key, Object.fromEntries(values))
  }
  let next: string | null = base
  for (const [name, value] of values) {
    next = next === null ? null : insertJsonProperty(next, [key], name, value)
  }
  return next
}

/** Whether the file already has a servers' table (Orca's TOML block never adds one). */
export function hasMcpServersTable(edit: McpAgentFileEdit, text: string): boolean {
  const parsed = parseAgentMcpConfigText(text, edit.format)
  return (
    edit.format === 'toml' || (parsed !== null && Object.hasOwn(parsed, SERVERS_KEY[edit.agent]))
  )
}

/** Nothing of the user's is in it: the file Orca made can go. */
export function isEmptyMcpAgentFile(edit: McpAgentFileEdit, text: string): boolean {
  if (edit.format === 'toml') {
    return text.trim() === ''
  }
  const parsed = parseAgentMcpConfigText(text, 'json')
  return parsed !== null && Object.keys(parsed).length === 0
}
