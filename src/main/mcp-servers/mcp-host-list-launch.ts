// Reading the host's MCP server list for a launch: each server's agent and workspace switches, and
// the servers a new session gets. Read only, so a launch never writes the list.
import type { BotToolServer } from '../../shared/bot-tools'
import {
  ALL_MCP_SERVER_WORKSPACES,
  isMcpServerOnInWorkspace,
  MCP_SERVER_AGENT_PATTERN,
  McpServerWorkspacesSchema,
  type McpServer,
  type McpServerWorkspaces
} from '../../shared/mcp-servers/mcp-servers'
import { botToolEntries, readBotToolsSnapshot } from '../bots/bot-tools-file'
import { mcpHostListFolder } from './mcp-host-list-folder'

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
): Promise<BotToolServer[]> {
  // Read only: a launch never writes the list, even to give an entry edited outside Orca its id.
  return botToolEntries(await readBotToolsSnapshot(folder)).flatMap(({ server, extras }) =>
    isOnForLaunch(extras, agent, workspace) ? [server] : []
  )
}

/** The server with `id` as a session of `agent` in `workspace` gets it; null when it's off there or gone. */
export async function mcpServerForLaunch(
  id: string,
  agent: string,
  workspace: LaunchWorkspace,
  folder = mcpHostListFolder()
): Promise<BotToolServer | null> {
  const entry = botToolEntries(await readBotToolsSnapshot(folder)).find(
    (candidate) => candidate.extras.id === id
  )
  return entry && isOnForLaunch(entry.extras, agent, workspace) ? entry.server : null
}
