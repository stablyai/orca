// Reading the host's MCP server list for a launch: each server's agent and workspace switches, and
// the servers a new session gets. Read only, so a launch never writes the list.
import { createHash } from 'node:crypto'
import type { BotToolServer } from '../../shared/bot-tools'
import {
  ALL_MCP_SERVER_WORKSPACES,
  isMcpServerOnInWorkspace,
  MCP_SERVER_AGENT_PATTERN,
  McpServerWorkspacesSchema,
  type McpServer,
  type McpServerWorkspaces
} from '../../shared/mcp-servers/mcp-servers'
import { botToolCredentialFingerprints } from '../bots/bot-tool-credentials'
import { botToolEntries, readBotToolsSnapshot } from '../bots/bot-tools-file'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { sharedIds, type McpLaunchServers } from './mcp-shared-process-servers'

// An entry whose workspaces Orca can't read is on nowhere, never everywhere.
const NO_WORKSPACES: McpServerWorkspaces = { later: false, on: [], off: [] }

export type McpServerSettings = Pick<McpServer, 'agentsOff' | 'workspaces' | 'sharedProcess'>

export function mcpServerSettingsOf(extras: Record<string, unknown>): McpServerSettings {
  const agentsOff = Array.isArray(extras.agentsOff)
    ? extras.agentsOff.filter(
        (agent): agent is string =>
          typeof agent === 'string' && MCP_SERVER_AGENT_PATTERN.test(agent)
      )
    : []
  const workspaces =
    extras.workspaces === undefined
      ? ALL_MCP_SERVER_WORKSPACES
      : (McpServerWorkspacesSchema.safeParse(extras.workspaces).data ?? NO_WORKSPACES)
  return {
    agentsOff: [...new Set(agentsOff)],
    workspaces,
    sharedProcess: extras.sharedProcess === true
  }
}

type LaunchWorkspace = { key: string | null } | 'any'

function isOnForLaunch(
  extras: Record<string, unknown>,
  agent: string,
  workspace: LaunchWorkspace
): boolean {
  const settings = mcpServerSettingsOf(extras)
  return (
    !settings.agentsOff.includes(agent) &&
    (workspace === 'any' || isMcpServerOnInWorkspace(settings.workspaces, workspace.key))
  )
}

/**
 * The servers a new session of `agent` gets: those on for the agent and on in the workspace with
 * `key` (null for none). A bot's session (`'any'`) takes them whichever workspaces they're on in.
 */
export async function mcpServersForLaunch(
  agent: string,
  workspace: LaunchWorkspace,
  folder = mcpHostListFolder()
): Promise<McpLaunchServers> {
  const { all, on } = await launchEntries(agent, workspace, folder)
  const names = new Set(on.map(({ server }) => server.name))
  const shared = [...sharedIds(all)].filter(([name]) => names.has(name))
  return { servers: on.map(({ server }) => server), sharedProcesses: new Map(shared) }
}

/**
 * As `mcpServersForLaunch`, with each server's digest by name: it changes only when that server or
 * its saved values or sign-in do (not when a token refreshes), so a running session can tell which
 * of its servers an edit touched.
 */
export async function mcpServersWithDigestsForLaunch(
  agent: string,
  workspace: LaunchWorkspace,
  folder = mcpHostListFolder()
): Promise<McpLaunchServers & { digests: Record<string, string> }> {
  const { servers, sharedProcesses } = await mcpServersForLaunch(agent, workspace, folder)
  const saved = savedValues(
    folder,
    new Set(
      servers.flatMap((server) => ('url' in server && server.credential ? [server.credential] : []))
    )
  )
  const digests = Object.fromEntries(
    servers.map((server) => [
      server.name,
      createHash('sha256')
        .update(JSON.stringify(server))
        .update(
          'url' in server && server.credential
            ? JSON.stringify(saved.get(server.credential) ?? null)
            : ''
        )
        // Sharing switched on or off changes where its sessions reach it.
        .update(sharedProcesses.has(server.name) ? 'shared' : '')
        .digest('hex')
    ])
  )
  return { servers, sharedProcesses, digests }
}

/**
 * Each credential's saved values or sign-in, as the tools revision counts them, from one read of
 * the store. A store Orca can't read never keeps the servers from launching.
 */
function savedValues(folder: string, credentials: ReadonlySet<string>): Map<string, unknown> {
  if (credentials.size === 0) {
    return new Map()
  }
  try {
    return botToolCredentialFingerprints(folder, credentials)
  } catch {
    return new Map([...credentials].map((id) => [id, 'unreadable']))
  }
}

/** The server with `id` as a session of `agent` in `workspace` gets it; null when it's off there or gone. */
export async function mcpServerForLaunch(
  id: string,
  agent: string,
  workspace: LaunchWorkspace,
  folder = mcpHostListFolder()
): Promise<BotToolServer | null> {
  const entry = (await launchEntries(agent, workspace, folder)).on.find(
    (candidate) => candidate.extras.id === id
  )
  return entry?.server ?? null
}

/** The whole list, and the entries on for this launch. */
async function launchEntries(agent: string, workspace: LaunchWorkspace, folder: string) {
  // Read only: a launch never writes the list, even to give an entry edited outside Orca its id.
  const all = botToolEntries(await readBotToolsSnapshot(folder))
  return { all, on: all.filter(({ extras }) => isOnForLaunch(extras, agent, workspace)) }
}

/** A server a launch gets, with its id (null for an entry edited outside Orca that has none yet). */
export type McpLaunchEntry = { id: string | null; server: BotToolServer }

/** `mcpServersForLaunch` with each server's id: a repeated id names its first entry, as
 *  `mcpServerForLaunch` finds it. */
export async function mcpServerEntriesForLaunch(
  agent: string,
  workspace: LaunchWorkspace,
  folder = mcpHostListFolder()
): Promise<{ entries: McpLaunchEntry[]; sharedProcesses: ReadonlyMap<string, string> }> {
  const { all, on } = await launchEntries(agent, workspace, folder)
  const seen = new Set<string>()
  const entries = on.map(({ server, extras }) => {
    const given =
      typeof extras.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(extras.id) ? extras.id : null
    const id = given && !seen.has(given) ? given : null
    if (given) {
      seen.add(given)
    }
    return { id, server }
  })
  const names = new Set(on.map(({ server }) => server.name))
  return {
    entries,
    sharedProcesses: new Map([...sharedIds(all)].filter(([name]) => names.has(name)))
  }
}
