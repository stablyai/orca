// A host's own MCP server list: a bot-tools file in a folder of its own, so its saved headers,
// sign-ins and relay addresses key by that folder exactly as a bot's do. Each server's id, agents,
// workspaces and shared-process choice ride on the entry's extra keys, which bot tools keep as they are.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { freeBotToolName, type BotToolInput, type BotToolServer } from '../../shared/bot-tools'
import {
  ALL_MCP_SERVER_WORKSPACES,
  MCP_SERVER_AGENT_PATTERN,
  McpServerWorkspacesSchema,
  type McpServer,
  type McpServerWorkspaces
} from '../../shared/mcp-servers/mcp-servers'
import { readBotToolDetails, resolveBotToolInput } from '../bots/bot-tool-details'
import { withSavedBotToolHeaders } from '../bots/bot-tool-credentials'
import {
  botOwnTool,
  botToolEntries,
  changeBotToolEntries,
  readBotToolsSnapshot
} from '../bots/bot-tools-file'
import type { BotToolEntry } from '../bots/bot-tool-entry-extras'
import { classifyAddedBotTool, ownedSignInKey } from '../bots/tool-oauth/bot-tool-owned-sign-in'
import type { BotToolOAuthKey } from '../bots/tool-oauth/bot-tool-oauth'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { McpServersError } from './mcp-servers-error'

/** `<userData>/mcp-servers`; the list is `.orca/bot-tools.json` inside, as in a bot's home. */
export const mcpHostListFolder = (): string => join(getProfileUserDataPath(), 'mcp-servers')

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
// An entry whose workspaces Orca can't read is on nowhere, never everywhere.
const NO_WORKSPACES: McpServerWorkspaces = { later: false, on: [], off: [] }

type HostEntry = BotToolEntry & { id: string }

const gone = (): McpServersError =>
  new McpServersError('mcp_server_gone', 'This server is no longer on this host.')
const nameTaken = (name: string): McpServersError =>
  new McpServersError('mcp_server_name_taken', `This host already has a server named ${name}.`)

type ServerSettings = Pick<McpServer, 'agentsOff' | 'workspaces' | 'sharedProcess'>

function settingsOf(extras: Record<string, unknown>): ServerSettings {
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

function viewOf(entry: HostEntry, folder: string): McpServer {
  const { signIn, ...tool } = botOwnTool(entry.server, folder)
  return {
    ...settingsOf(entry.extras),
    id: entry.id,
    name: tool.name,
    detail: tool.detail,
    transport: 'url' in entry.server ? 'http' : 'command',
    remote: tool.remote,
    ...(signIn ? { signIn } : {})
  }
}

/** Every entry with a unique id; one missing or repeated (an edit outside Orca) gets a new one. */
function withIds(entries: readonly BotToolEntry[]): { entries: HostEntry[]; assigned: boolean } {
  const seen = new Set<string>()
  let assigned = false
  const out = entries.map((entry): HostEntry => {
    const id = entry.extras.id
    if (typeof id === 'string' && ID_PATTERN.test(id) && !seen.has(id)) {
      seen.add(id)
      return { ...entry, id }
    }
    assigned = true
    const fresh = randomUUID()
    seen.add(fresh)
    return { ...entry, id: fresh, extras: { ...entry.extras, id: fresh } }
  })
  return { entries: out, assigned }
}

function changeHostEntries(
  folder: string,
  change: (entries: HostEntry[]) => HostEntry[],
  options?: Parameters<typeof changeBotToolEntries>[2]
): Promise<void> {
  return changeBotToolEntries(folder, (entries) => change(withIds(entries).entries), options)
}

async function readHostEntries(folder: string): Promise<{ entries: HostEntry[]; version: string }> {
  const snapshot = await readBotToolsSnapshot(folder)
  const read = withIds(botToolEntries(snapshot))
  if (!read.assigned) {
    return { entries: read.entries, version: snapshot.version }
  }
  await changeHostEntries(folder, (entries) => entries)
  const saved = await readBotToolsSnapshot(folder)
  return { entries: withIds(botToolEntries(saved)).entries, version: saved.version }
}

async function entryById(folder: string, id: string): Promise<HostEntry> {
  const entry = (await readHostEntries(folder)).entries.find((candidate) => candidate.id === id)
  if (!entry) {
    throw gone()
  }
  return entry
}

export async function listMcpServers(folder = mcpHostListFolder()): Promise<McpServer[]> {
  return (await readHostEntries(folder)).entries.map((entry) => viewOf(entry, folder))
}

/**
 * Adds `given`, as a server Orca signs in to when its address asks for a sign-in. A name from a
 * paste that's taken gets a free one (`linear-2`); a name the user gave is refused instead.
 */
export async function addMcpServer(
  given: BotToolServer,
  { nameGiven, signal }: { nameGiven: boolean; signal?: AbortSignal },
  folder = mcpHostListFolder()
): Promise<McpServer> {
  const { server, signIn } = await classifyAddedBotTool(given, signal)
  let added: HostEntry | undefined
  await changeHostEntries(
    folder,
    (entries) => {
      const taken = new Set(entries.map((entry) => entry.server.name))
      if (nameGiven && taken.has(server.name)) {
        throw nameTaken(server.name)
      }
      const id = randomUUID()
      added = {
        server: { ...server, name: freeBotToolName(server.name, taken) },
        extras: { id },
        id
      }
      return [...entries, added]
    },
    { credentials: signIn }
  )
  if (!added) {
    throw gone()
  }
  return viewOf(added, folder)
}

/** The editor's save; `version` is the one `mcpServerDetails` gave, so an edit made since refuses. */
export async function updateMcpServer(
  id: string,
  version: string,
  input: BotToolInput,
  folder = mcpHostListFolder()
): Promise<McpServer> {
  // The rename keeps a header server's credential id; the version check proves the name still holds.
  const from = (await entryById(folder, id)).server.name
  let updated: HostEntry | undefined
  await changeHostEntries(
    folder,
    (entries) => {
      const previous = entries.find((entry) => entry.id === id)
      if (!previous) {
        throw gone()
      }
      if (entries.some((entry) => entry !== previous && entry.server.name === input.name)) {
        throw nameTaken(input.name)
      }
      const server = resolveBotToolInput(input, withSavedBotToolHeaders(folder, previous.server))
      const next: HostEntry = { ...previous, server }
      updated = next
      return entries.map((entry) => (entry === previous ? next : entry))
    },
    { expectedVersion: version, rename: { from, to: input.name } }
  )
  if (!updated) {
    throw gone()
  }
  return viewOf(updated, folder)
}

/** Removing a server Orca signs in to revokes that sign-in with it (bot-tools-file's write). */
export async function removeMcpServer(id: string, folder = mcpHostListFolder()): Promise<void> {
  await changeHostEntries(folder, (entries) => {
    if (!entries.some((entry) => entry.id === id)) {
      throw gone()
    }
    return entries.filter((entry) => entry.id !== id)
  })
}

/** Changes one server's extra keys inside the file's transaction, so concurrent switches don't drop each other. */
async function changeMcpServerExtras(
  id: string,
  change: (entry: HostEntry) => Record<string, unknown>,
  folder: string
): Promise<McpServer> {
  let changed: HostEntry | undefined
  await changeHostEntries(folder, (entries) =>
    entries.map((entry) => {
      if (entry.id !== id) {
        return entry
      }
      changed = { ...entry, extras: { ...change(entry), id } }
      return changed
    })
  )
  if (!changed) {
    throw gone()
  }
  return viewOf(changed, folder)
}

export function setMcpServerAgentEnabled(
  id: string,
  agent: string,
  enabled: boolean,
  folder = mcpHostListFolder()
): Promise<McpServer> {
  return changeMcpServerExtras(
    id,
    (entry) => {
      const off = settingsOf(entry.extras).agentsOff.filter((other) => other !== agent)
      return { ...entry.extras, agentsOff: enabled ? off : [...off, agent] }
    },
    folder
  )
}

export function setMcpServerWorkspaces(
  id: string,
  workspaces: McpServerWorkspaces,
  folder = mcpHostListFolder()
): Promise<McpServer> {
  return changeMcpServerExtras(id, (entry) => ({ ...entry.extras, workspaces }), folder)
}

export function setMcpServerSharedProcess(
  id: string,
  enabled: boolean,
  folder = mcpHostListFolder()
): Promise<McpServer> {
  return changeMcpServerExtras(
    id,
    (entry) => {
      if ('url' in entry.server) {
        throw new McpServersError(
          'mcp_server_not_command',
          'Only a server Orca starts with a command can share one process.'
        )
      }
      return { ...entry.extras, sharedProcess: enabled }
    },
    folder
  )
}

/** The editor's view: saved values masked, with the version its save must send. */
export async function mcpServerDetails(id: string, folder = mcpHostListFolder()) {
  const details = await readBotToolDetails(folder, (await entryById(folder, id)).server.name)
  return { id, ...details }
}

/** The server's sign-in, when Orca signs in to it. */
export async function mcpServerSignInKey(
  id: string,
  folder = mcpHostListFolder()
): Promise<BotToolOAuthKey | null> {
  return ownedSignInKey(folder, (await entryById(folder, id)).server.name)
}

/** Each server's name to its id, for answers keyed by name (the bots' health checks). */
export async function mcpServerIdsByName(
  folder = mcpHostListFolder()
): Promise<Map<string, string>> {
  return new Map(
    (await readHostEntries(folder)).entries.map((entry) => [entry.server.name, entry.id])
  )
}
