// A host's own MCP server list: a bot-tools file in a folder of its own, so its saved headers,
// sign-ins and relay addresses key by that folder exactly as a bot's do. Each server's id, agents,
// workspaces and shared-process choice ride on the entry's extra keys, which bot tools keep as they are.
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { BotOwnTool, BotToolInput, BotToolServer } from '../../shared/bot-tools'
import {
  McpServerWorkspacesSchema,
  mergeMcpServerWorkspaces,
  type McpAgentFiles,
  type McpFileAgent,
  type McpServer,
  type McpServerWorkspaces
} from '../../shared/mcp-servers/mcp-servers'
import { botToolDetailsOf, resolveBotToolInput } from '../bots/bot-tool-details'
import {
  botToolCredentialsFingerprint,
  withSavedBotToolHeaders
} from '../bots/bot-tool-credentials'
import {
  botOwnTools,
  botToolEntries,
  changeBotToolEntries,
  readBotToolsSnapshot
} from '../bots/bot-tools-file'
import { mcpServerSettingsOf as settingsOf } from './mcp-host-list-launch'
import type { BotToolEntry } from '../bots/bot-tool-entry-extras'
import { classifyAddedBotTool } from '../bots/tool-oauth/bot-tool-owned-sign-in'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { McpServersError } from './mcp-servers-error'
import { assertNotFromPlugin, pluginViewOf } from './mcp-plugin-server-mark'

const AgentFilesSchema = z.record(z.string(), z.unknown())
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export type HostEntry = BotToolEntry & { id: string }

const gone = (): McpServersError =>
  new McpServersError('mcp_server_gone', 'This server is no longer on this host.')
export const nameTaken = (name: string): McpServersError =>
  new McpServersError('mcp_server_name_taken', `This host already has a server named ${name}.`)

function viewOf(entry: HostEntry, { signIn, ...tool }: BotOwnTool): McpServer {
  return {
    ...settingsOf(entry.extras),
    id: entry.id,
    name: tool.name,
    detail: tool.detail,
    transport: 'url' in entry.server ? 'http' : 'command',
    remote: tool.remote,
    ...(signIn ? { signIn } : {}),
    ...pluginViewOf(entry.extras)
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

export function changeHostEntries(
  folder: string,
  change: (entries: HostEntry[]) => HostEntry[],
  options?: Parameters<typeof changeBotToolEntries>[2]
): Promise<void> {
  return changeBotToolEntries(folder, (entries) => change(withIds(entries).entries), options)
}

type HostList = { entries: HostEntry[]; file: Readonly<Record<string, unknown>> }

export async function readHostEntries(folder: string): Promise<HostList> {
  const snapshot = await readBotToolsSnapshot(folder)
  const read = withIds(botToolEntries(snapshot))
  if (!read.assigned) {
    return { entries: read.entries, file: snapshot.file }
  }
  await changeHostEntries(folder, (entries) => entries)
  const saved = await readBotToolsSnapshot(folder)
  return { entries: withIds(botToolEntries(saved)).entries, file: saved.file }
}

/** The file's `agentFiles`: which agents' own MCP file the user let Orca keep its servers in. */
export function agentFilesOf(file: Readonly<Record<string, unknown>>): McpAgentFiles {
  const stored = AgentFilesSchema.safeParse(file.agentFiles).data ?? {}
  const allowed = (agent: McpFileAgent): boolean => stored[agent] === true
  return { grok: allowed('grok'), cursor: allowed('cursor'), droid: allowed('droid') }
}

export async function entryById(folder: string, id: string): Promise<HostEntry> {
  const entry = (await readHostEntries(folder)).entries.find((candidate) => candidate.id === id)
  if (!entry) {
    throw gone()
  }
  return entry
}

/** The servers as the write stored them: credential ids and sign-ins are the file's, not the input's. */
export async function storedViews(folder: string, ids: readonly string[]): Promise<McpServer[]> {
  if (ids.length === 0) {
    return []
  }
  const wanted = new Set(ids)
  const byId = new Map(
    (await readHostEntries(folder)).entries.flatMap((entry) =>
      wanted.has(entry.id) ? [[entry.id, entry] as const] : []
    )
  )
  const entries = ids.map((id) => {
    const entry = byId.get(id)
    if (!entry) {
      throw gone()
    }
    return entry
  })
  const tools = botOwnTools(
    entries.map((entry) => entry.server),
    folder
  )
  return entries.map((entry, i) => viewOf(entry, tools[i]!))
}

export async function storedView(folder: string, id: string): Promise<McpServer> {
  return (await storedViews(folder, [id]))[0]!
}

/** The server's own settings and saved values, never its switches. */
function serverVersion(folder: string, server: BotToolServer): string {
  const credential = 'url' in server ? server.credential : undefined
  return createHash('sha256')
    .update(JSON.stringify(server))
    .update(botToolCredentialsFingerprint(folder, new Set(credential ? [credential] : [])))
    .digest('hex')
}

export async function listMcpServers(folder = mcpHostListFolder()): Promise<McpServer[]> {
  return (await readMcpHostList(folder)).servers
}

/** What mcpServers.list answers: the servers, and the agents whose own file Orca may keep them in. */
export async function readMcpHostList(
  folder = mcpHostListFolder()
): Promise<{ servers: McpServer[]; agentFiles: McpAgentFiles }> {
  const { entries, file } = await readHostEntries(folder)
  const tools = botOwnTools(
    entries.map((entry) => entry.server),
    folder
  )
  return {
    servers: entries.map((entry, i) => viewOf(entry, tools[i]!)),
    agentFiles: agentFilesOf(file)
  }
}

/** The user's consent, or its withdrawal, for Orca to keep its servers in `agent`'s own MCP file. */
export async function setMcpAgentFileAllowed(
  agent: McpFileAgent,
  allowed: boolean,
  folder = mcpHostListFolder()
): Promise<McpAgentFiles> {
  await changeHostEntries(folder, (entries) => entries, {
    topLevel: (file) => ({ ...file, agentFiles: { ...agentFilesOf(file), [agent]: allowed } })
  })
  return (await readMcpHostList(folder)).agentFiles
}

/**
 * The editor's save; `version` is the one `mcpServerDetails` gave, so an edit to this server since
 * refuses. It covers only the server's own settings: a switch flipped meanwhile doesn't.
 */
export async function updateMcpServer(
  id: string,
  version: string,
  input: BotToolInput,
  { signal }: { signal?: AbortSignal } = {},
  folder = mcpHostListFolder()
): Promise<McpServer> {
  // Resolved against this read; the version check inside the write proves it still holds, so the
  // rename (which keeps a header server's credential id) and any new sign-in fit the stored entry.
  const before = await entryById(folder, id)
  assertNotFromPlugin(before.extras)
  const resolved = resolveBotToolInput(input, withSavedBotToolHeaders(folder, before.server))
  // A new address with no saved values is sorted as add sorts one: it may need Orca's sign-in.
  const newAddress =
    'url' in resolved &&
    !resolved.credential &&
    Object.keys(resolved.headers ?? {}).length === 0 &&
    !('url' in before.server && before.server.url === resolved.url)
  const { server, signIn } = newAddress
    ? await classifyAddedBotTool(resolved, signal)
    : { server: resolved, signIn: undefined }
  await changeHostEntries(
    folder,
    (entries) => {
      const previous = entries.find((entry) => entry.id === id)
      if (!previous) {
        throw gone()
      }
      assertNotFromPlugin(previous.extras)
      if (serverVersion(folder, previous.server) !== version) {
        throw new McpServersError(
          'mcp_server_stale',
          'This server changed since the editor opened. Reopen it before saving.'
        )
      }
      if (entries.some((entry) => entry !== previous && entry.server.name === input.name)) {
        throw nameTaken(input.name)
      }
      // Sharing one process is only for a command server; an HTTP replacement drops it.
      const { sharedProcess: _shared, ...extras } = previous.extras
      const next = 'url' in server ? { ...previous, server, extras } : { ...previous, server }
      return entries.map((entry) => (entry === previous ? next : entry))
    },
    { rename: { from: before.server.name, to: input.name }, credentials: signIn }
  )
  return storedView(folder, id)
}

/** Removing a server Orca signs in to revokes that sign-in with it (bot-tools-file's write). A
 *  plugin's server goes only with the plugin, or the next sync would bring it back. */
export async function removeMcpServer(id: string, folder = mcpHostListFolder()): Promise<void> {
  await changeHostEntries(folder, (entries) => {
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) {
      throw gone()
    }
    assertNotFromPlugin(entry.extras)
    return entries.filter((candidate) => candidate !== entry)
  })
}

/** Changes one server's extra keys inside the file's transaction, so concurrent switches don't drop each other. */
async function changeMcpServerExtras(
  id: string,
  change: (entry: HostEntry) => Record<string, unknown>,
  folder: string
): Promise<McpServer> {
  await changeHostEntries(folder, (entries) => {
    if (!entries.some((entry) => entry.id === id)) {
      throw gone()
    }
    return entries.map((entry) =>
      entry.id === id ? { ...entry, extras: { ...change(entry), id } } : entry
    )
  })
  return storedView(folder, id)
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
      const { agentsOff } = settingsOf(entry.extras)
      if (agentsOff.includes(agent) !== enabled) {
        return entry.extras
      }
      const off = agentsOff.filter((other) => other !== agent)
      return { ...entry.extras, agentsOff: enabled ? off : [...off, agent] }
    },
    folder
  )
}

/**
 * With `base` (the choice the editor showed), only what the editor changed is written, so a save
 * from another client since then survives; without it (an older client), `workspaces` replaces it.
 */
export function setMcpServerWorkspaces(
  id: string,
  workspaces: McpServerWorkspaces,
  { base, folder = mcpHostListFolder() }: { base?: McpServerWorkspaces; folder?: string } = {}
): Promise<McpServer> {
  return changeMcpServerExtras(
    id,
    (entry) => {
      const stored = settingsOf(entry.extras).workspaces
      // Parsed again: a merge past the schema's caps would read back as on nowhere.
      const next = base
        ? McpServerWorkspacesSchema.parse(mergeMcpServerWorkspaces(stored, base, workspaces))
        : workspaces
      return JSON.stringify(next) === JSON.stringify(stored)
        ? entry.extras
        : { ...entry.extras, workspaces: next }
    },
    folder
  )
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
      return settingsOf(entry.extras).sharedProcess === enabled
        ? entry.extras
        : { ...entry.extras, sharedProcess: enabled }
    },
    folder
  )
}

/** The editor's view: saved values masked, with the version its save must send. */
export async function mcpServerDetails(id: string, folder = mcpHostListFolder()) {
  const { server } = await entryById(folder, id)
  return { id, ...botToolDetailsOf(folder, server, serverVersion(folder, server)) }
}

/** Each server's name to its id, for answers keyed by name (the bots' health checks). */
export async function mcpServerIdsByName(
  folder = mcpHostListFolder()
): Promise<Map<string, string>> {
  return new Map(
    (await readHostEntries(folder)).entries.map((entry) => [entry.server.name, entry.id])
  )
}
