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
import { botToolEntries, readBotToolsSnapshot, type BotToolsSnapshot } from '../bots/bot-tools-file'
import type { BotToolEntry } from '../bots/bot-tool-entry-extras'
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

/** Reads the host list as it stands now (`readBotToolsSnapshot`), or as another reader just did. */
export type McpHostListRead = (folder: string) => Promise<BotToolsSnapshot>

// One write advances the epoch for every running chat; the first to compare after it reads the
// list, and the rest share that read (a later write starts a new one). A failed read isn't kept.
let epochRead: { folder: string; epoch: number; snapshot: Promise<BotToolsSnapshot> } | null = null

/** The list as read at `epoch` (`botToolsEpoch`, taken before the read): one read for every caller. */
export function mcpHostListAtEpoch(folder: string, epoch: number): Promise<BotToolsSnapshot> {
  if (epochRead?.folder === folder && epochRead.epoch === epoch) {
    return epochRead.snapshot
  }
  const read = { folder, epoch, snapshot: readBotToolsSnapshot(folder) }
  epochRead = read
  read.snapshot.catch(() => {
    if (epochRead === read) {
      epochRead = null
    }
  })
  return read.snapshot
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
  return launchServersIn(await launchEntries(agent, workspace, folder))
}

function launchServersIn({ all, on }: LaunchEntries): McpLaunchServers {
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
  folder = mcpHostListFolder(),
  read: McpHostListRead = readBotToolsSnapshot
): Promise<McpLaunchServers & { digests: Record<string, string> }> {
  const entries = await launchEntries(agent, workspace, folder, read)
  const { servers, sharedProcesses } = launchServersIn(entries)
  const known = digestsOf(entries.snapshot)
  const digests = Object.fromEntries(
    servers.map((server) => {
      const digest = known.get(server.name) ?? digestOf(server, entries.snapshot, sharedProcesses)
      known.set(server.name, digest)
      return [server.name, digest]
    })
  )
  return { servers, sharedProcesses, digests }
}

// A server's digest depends on the list alone, so chats comparing against one shared read hash it once.
const digestsBySnapshot = new WeakMap<BotToolsSnapshot, Map<string, string>>()

function digestsOf(snapshot: BotToolsSnapshot): Map<string, string> {
  const known = digestsBySnapshot.get(snapshot) ?? new Map<string, string>()
  digestsBySnapshot.set(snapshot, known)
  return known
}

function digestOf(
  server: BotToolServer,
  snapshot: BotToolsSnapshot,
  sharedProcesses: ReadonlyMap<string, string>
): string {
  return (
    createHash('sha256')
      .update(JSON.stringify(server))
      // The snapshot's own read of the credential store, as the tools revision counts each credential.
      .update(
        'url' in server && server.credential
          ? JSON.stringify(snapshot.credentials.get(server.credential) ?? null)
          : ''
      )
      // Sharing switched on or off changes where its sessions reach it.
      .update(sharedProcesses.has(server.name) ? 'shared' : '')
      .digest('hex')
  )
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

type LaunchEntries = { snapshot: BotToolsSnapshot; all: BotToolEntry[]; on: BotToolEntry[] }

/** The whole list, and the entries on for this launch. */
async function launchEntries(
  agent: string,
  workspace: LaunchWorkspace,
  folder: string,
  read: McpHostListRead = readBotToolsSnapshot
): Promise<LaunchEntries> {
  // Read only: a launch never writes the list, even to give an entry edited outside Orca its id.
  const snapshot = await read(folder)
  const all = botToolEntries(snapshot)
  return { snapshot, all, on: all.filter(({ extras }) => isOnForLaunch(extras, agent, workspace)) }
}

/** A server a launch gets, with its id (null for an entry edited outside Orca that has none yet). */
export type McpLaunchEntry = { id: string | null; server: BotToolServer }

/** `mcpServersForLaunch` with each server's id: a repeated id names its first entry, as
 *  `mcpServerForLaunch` finds it. */
export async function mcpServerEntriesForLaunch(
  agent: string,
  workspace: LaunchWorkspace,
  folder = mcpHostListFolder(),
  read?: McpHostListRead
): Promise<{ entries: McpLaunchEntry[]; sharedProcesses: ReadonlyMap<string, string> }> {
  const { all, on } = await launchEntries(agent, workspace, folder, read)
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
