// The entry Orca keeps for one of its servers in Grok's, Cursor's or Droid's own MCP file: this
// app's CLI by absolute path, running `orca mcp connect`, pinned to this Orca's data folder so a dev
// build and the installed app each answer for their own list.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { McpFileAgent } from '../../../shared/mcp-servers/mcp-servers'
import type { ManagedTomlMarkers } from '../../agent-hooks/installation/configuration/managed-toml-ownership'
import { cmdShimArgument } from '../../bots/bot-tools-claude'

export type McpAgentFileEntry = { command: string; args: string[]; env: Record<string, string> }

/** The Orca instance the entries belong to: its data folder and its CLI launcher. */
export type McpAgentFileInstance = { userDataPath: string; launcher: string }

export function mcpAgentFileEntry(
  instance: McpAgentFileInstance,
  serverId: string,
  agent: McpFileAgent,
  platform: NodeJS.Platform
): McpAgentFileEntry {
  const args = ['mcp', 'connect', serverId, '--agent', agent]
  const env = { ORCA_USER_DATA_PATH: instance.userDataPath }
  // A dev build's launcher is a .cmd script, which the agents can only start through cmd.
  return platform === 'win32' && /\.(cmd|bat)$/i.test(instance.launcher)
    ? { command: 'cmd', args: ['/c', instance.launcher, ...args.map(cmdShimArgument)], env }
    : { command: instance.launcher, args, env }
}

/**
 * The entry's name: the server's, then this Orca's data folder by name and a short hash of its full
 * path (`linear-orca-3f2a1c`), so two Orcas on one machine never claim one name, even two profiles
 * whose folders are both called `orca`.
 */
export function mcpAgentFileEntryName(serverName: string, userDataPath: string): string {
  return `${serverName}${entrySuffix(userDataPath)}`
}

const instanceHash = (userDataPath: string): string =>
  createHash('sha256').update(userDataPath).digest('hex')

function entrySuffix(userDataPath: string): string {
  const folder = basename(userDataPath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 24)
  return `-${folder || 'orca'}-${instanceHash(userDataPath).slice(0, 6)}`
}

/** The host server an entry this Orca wrote stands for, by name; null for anyone else's entry. */
export function mcpHostServerNameOfEntry(
  entryName: string,
  entryEnv: Readonly<Record<string, string>> | undefined,
  userDataPath: string
): string | null {
  const suffix = entrySuffix(userDataPath)
  return entryEnv?.ORCA_USER_DATA_PATH === userDataPath && entryName.endsWith(suffix)
    ? entryName.slice(0, entryName.length - suffix.length)
    : null
}

/** Where this instance holds an agent's file while it decides whether it can delete it. */
export function mcpAgentFileHeldPath(path: string, userDataPath: string): string {
  return `${path}.orca-held-${instanceHash(userDataPath).slice(0, 12)}`
}

/** The marker lines around this instance's block in a TOML file. */
export function mcpAgentFileMarkers(userDataPath: string): ManagedTomlMarkers {
  const tag = instanceHash(userDataPath).slice(0, 12)
  return {
    startMarker: `# BEGIN ORCA MCP SERVERS ${tag}`,
    endMarker: `# END ORCA MCP SERVERS ${tag}`
  }
}
