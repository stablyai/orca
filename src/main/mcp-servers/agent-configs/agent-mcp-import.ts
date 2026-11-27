// "In your agents": list the servers agents keep in their own configs, and Move or Copy one into
// Orca's host list. Move adds first, then takes the entries out of the agents' files, so a failed
// removal never loses the server. It takes them only from agents whose sessions get Orca's list on
// this host: any other agent would lose a working server, so it keeps its copy.
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'
import { botToolDetail, type BotToolServer } from '../../../shared/bot-tools'
import type {
  DiscoveredMcpServer,
  McpServerWorkspaces
} from '../../../shared/mcp-servers/mcp-servers'
import { agentMcpServerMergeKey } from '../../../shared/mcp/agent-mcp-config-entry'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../shared/file-access/cross-platform-path'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/profiles/claude-profile-homes'
import { getOrcaUserDataPath } from '../../codex/configuration/homes/codex-home-paths'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { claudeGlobalConfigFile, type AgentMcpConfigContext } from './agent-mcp-config-locations'
import {
  discoverAgentMcpServers,
  type AgentMcpConfigSource,
  type DiscoveredAgentMcpServer
} from './agent-mcp-config-read'
import { removeAgentMcpServerEntries } from './agent-mcp-config-removal'

export type AgentMcpServerRow = DiscoveredMcpServer

/** Only these workspaces; null keeps a server on everywhere. */
export type AgentMcpServerWorkspaces = McpServerWorkspaces | null

/** The host's workspace key and name for a project folder, or null when Orca doesn't know it. */
export type WorkspaceForPath = (projectPath: string) => { key: string; name: string } | null

export type ImportedMcpServerScope = {
  workspaces: AgentMcpServerWorkspaces
  /** Agents whose own copy was switched off: the server stays off for them in Orca. */
  agentsOff: string[]
}

export type AddImportedMcpServer<T> = (
  server: BotToolServer,
  scope: ImportedMcpServerScope,
  /** No agent copy is taken out (a Copy, or a Move whose agents Orca's list doesn't reach), so
   *  a server Orca already has with this definition serves as is. */
  keepsCopies: boolean
) => Promise<T>

export class AgentMcpServerImportError extends Error {
  constructor(readonly reason: 'gone' | 'not-movable') {
    super(
      reason === 'gone'
        ? 'That server changed in its agent’s settings. Refresh and try again.'
        : 'That server is limited to a folder Orca doesn’t know, so it stays in its agent.'
    )
    this.name = 'AgentMcpServerImportError'
  }
}

export type AgentMcpImportHost = {
  context: AgentMcpConfigContext
  /** Orca's data folder, which holds the managed Claude account profiles. */
  userDataPath: string
  /** Read only when a server is limited to project folders: it lists every workspace on the host. */
  workspaceFor: () => Promise<WorkspaceForPath>
  /** Claude projects Orca made itself (bots' sign-in folders), never the user's. */
  isOrcaProject: (projectPath: string) => boolean
  /** Whether each agent's new sessions on this host get Orca's list, so Move may take its copy. */
  listReaches: (agents: readonly string[]) => Promise<AgentMcpReach>
}

export type AgentMcpReach = (agent: string) => boolean

export function localAgentMcpImportHost(
  userDataPath: string,
  workspaceFor: () => Promise<WorkspaceForPath>,
  listReaches: AgentMcpImportHost['listReaches']
): AgentMcpImportHost {
  return {
    context: { homeDir: homedir(), env: process.env, platform: process.platform },
    userDataPath,
    workspaceFor,
    isOrcaProject: isOrcaDataProject,
    listReaches
  }
}

// Bots' sign-in folders under Orca's data hold Orca's own mirrors of bot tools.
function isOrcaDataProject(projectPath: string): boolean {
  return [getProfileUserDataPath(), getOrcaUserDataPath()].some((root) =>
    isPathInsideOrEqual(root, projectPath)
  )
}

type ImportRow = {
  found: DiscoveredAgentMcpServer
  /** The copies Move takes out: those of agents Orca's list reaches. */
  removing: AgentMcpConfigSource[]
  row: AgentMcpServerRow
  scope: ImportedMcpServerScope
}

/** The project folders a server is limited to, or null when it reaches every workspace. */
function limitedTo(found: DiscoveredAgentMcpServer): string[] | null {
  // The copies that were on decide where the server reaches; when every copy was off, all of them.
  const enabled = found.sources.filter((source) => !source.disabled)
  const reach = enabled.length > 0 ? enabled : found.sources
  // One unscoped copy means every workspace already gets it.
  if (reach.some((source) => source.projectPath === undefined)) {
    return null
  }
  return reach.flatMap((source) => (source.projectPath === undefined ? [] : [source.projectPath]))
}

const agentsOf = (sources: readonly AgentMcpConfigSource[]): string[] =>
  sources.map((source) => source.agent)

type MappedPath = { path: string; workspace: ReturnType<WorkspaceForPath> }

function importRow(
  found: DiscoveredAgentMcpServer,
  mapped: MappedPath[] | null,
  listReaches: AgentMcpReach
): ImportRow {
  const paths = mapped ?? []
  const keys = [...new Set(paths.flatMap(({ workspace }) => (workspace ? [workspace.key] : [])))]
  const agents = [...new Set(found.sources.map((source) => source.agent))]
  const removing = found.sources.filter((source) => listReaches(source.agent))
  return {
    found,
    removing,
    scope: {
      workspaces: mapped ? { later: false, on: keys, off: [] } : null,
      agentsOff: agents.filter((agent) =>
        found.sources.every((source) => source.agent !== agent || source.disabled)
      )
    },
    row: {
      key: found.key,
      name: found.server.name,
      detail: botToolDetail(found.server),
      transport: 'url' in found.server ? 'http' : 'command',
      agents,
      removesFrom: [...new Set(removing.map((source) => source.agent))],
      files: [...new Set(found.sources.map((source) => source.path))],
      projectNames: [
        ...new Set(paths.map(({ path, workspace }) => workspace?.name ?? basename(path)))
      ],
      movable:
        found.sources.every((source) => source.scope === 'user') &&
        paths.every(({ workspace }) => workspace !== null)
    }
  }
}

/**
 * `removals`: whether the rows need what Move would take out (no Copy does), or the only agents it
 * may take it out of (a Move's confirm), so no other agent's reach is read.
 */
async function importRows(
  host: AgentMcpImportHost,
  found: readonly DiscoveredAgentMcpServer[],
  removals: boolean | readonly string[] = true
): Promise<ImportRow[]> {
  const limits = found.map(limitedTo)
  const workspaceFor = limits.some((paths) => paths !== null) ? await host.workspaceFor() : null
  const sourceAgents = (): string[] => [
    ...new Set(found.flatMap((server) => agentsOf(server.sources)))
  ]
  const agents =
    removals === false
      ? []
      : removals === true
        ? sourceAgents()
        : sourceAgents().filter((agent) => removals.includes(agent))
  const reaches = agents.length > 0 ? await host.listReaches(agents) : () => false
  return found.map((server, index) =>
    importRow(
      server,
      limits[index]?.map((path) => ({ path, workspace: workspaceFor?.(path) ?? null })) ?? null,
      reaches
    )
  )
}

const discover = (host: AgentMcpImportHost): Promise<DiscoveredAgentMcpServer[]> =>
  discoverAgentMcpServers(host.context, host.isOrcaProject)

export async function listAgentMcpServers(host: AgentMcpImportHost): Promise<AgentMcpServerRow[]> {
  return (await importRows(host, await discover(host))).map(({ row }) => row)
}

const importQueue = new Map<string, Promise<void>>()

// A second Move of the same row (a double tap, another client) re-reads after the first finished,
// so it finds the server gone instead of adding it twice.
const oneImportAtATime = <T>(run: () => Promise<T>): Promise<T> =>
  runKeyedSerializedOperation(importQueue, 'import', run)

async function movableRow(
  host: AgentMcpImportHost,
  key: string,
  removals: boolean | readonly string[]
): Promise<ImportRow> {
  const server = (await discover(host)).find((candidate) => candidate.key === key)
  if (!server) {
    throw new AgentMcpServerImportError('gone')
  }
  const [found] = await importRows(host, [server], removals)
  if (!found.row.movable) {
    throw new AgentMcpServerImportError('not-movable')
  }
  return found
}

/** Copy to Orca: the agents keep their entries. */
export async function copyAgentMcpServer<T>(
  host: AgentMcpImportHost,
  key: string,
  add: AddImportedMcpServer<T>
): Promise<T> {
  return oneImportAtATime(async () => {
    const { found, scope } = await movableRow(host, key, false)
    return add(found.server, scope, true)
  })
}

// Orca's managed Claude accounts copy ~/.claude.json's servers forward and never drop one.
async function claudeProfileCopies(
  host: AgentMcpImportHost,
  sources: readonly AgentMcpConfigSource[]
): Promise<AgentMcpConfigSource[]> {
  const claude = sources.filter((source) => source.agent === 'claude' && source.scope === 'user')
  if (claude.length === 0) {
    return []
  }
  const homes = await listClaudeProfileHomesAsync(host.userDataPath)
  const files = await Promise.all(homes.map((home) => claudeGlobalConfigFile(host.context, home)))
  return files.flatMap((path) => claude.map((source) => ({ ...source, path })))
}

/**
 * Move to Orca: adds it (limited to the workspaces a project-scoped copy was for), then removes it
 * from the files of the agents Orca's list reaches and from Orca's Claude account profiles, keeping
 * a backup of each. With no such agent it is a Copy. `confirmed`: the agents the user was shown it
 * leaves (absent from older clients); no other agent ever loses its copy.
 */
export async function moveAgentMcpServer<T>(
  host: AgentMcpImportHost,
  key: string,
  add: AddImportedMcpServer<T>,
  confirmed?: readonly string[]
): Promise<T> {
  return oneImportAtATime(async () => {
    const { found, removing: reached, scope } = await movableRow(host, key, confirmed ?? true)
    const listed = confirmed
      ? reached.filter((source) => confirmed.includes(source.agent))
      : reached
    const added = await add(found.server, scope, listed.length === 0)
    // Reach can shrink while the add runs (consent withdrawn, a launch learned the agent can't
    // take the servers): an agent that lost it keeps its copy. One that gained it wasn't confirmed.
    const reaches = listed.length > 0 ? await host.listReaches(agentsOf(listed)) : null
    const removing = listed.filter((source) => reaches?.(source.agent))
    const configName = found.sources[0]!.keyPath.at(-1)!
    const mergeKey = agentMcpServerMergeKey(configName, found.server)
    await removeAgentMcpServerEntries(removing, mergeKey)
    try {
      // A profile entry the user changed in that account is theirs to keep.
      await removeAgentMcpServerEntries(await claudeProfileCopies(host, removing), mergeKey, {
        differing: 'skip'
      })
    } catch (error) {
      // The move itself is done; an account profile that keeps its copy only shadows it there.
      console.warn(
        '[mcp-servers] Couldn’t remove a moved server from a Claude account profile:',
        error
      )
    }
    return added
  })
}

export type HostWorkspaceFolders = {
  repos: readonly { id: string; path: string; displayName: string }[]
  worktrees: readonly { repoId: string; path: string }[]
  folderWorkspaces: readonly { id: string; name: string; folderPath: string }[]
}

/** `path` (a comparison key) and each folder above it, deepest first, as comparison keys too. */
function* comparisonKeyAndParents(path: string): Generator<string> {
  yield path
  for (let cut = path.lastIndexOf('/'); cut >= 0; cut = path.lastIndexOf('/', cut - 1)) {
    const parent = path.slice(0, cut)
    // A filesystem root keeps its slash, as the comparison key of `/` or `C:/` does.
    yield parent === '' ? '/' : /^[a-z]:$/i.test(parent) ? `${parent}/` : parent
    if (cut === 0) {
      return
    }
  }
}

/** The deepest repo, worktree or folder workspace holding `projectPath`, as a workspace key. */
export function workspaceForPathIn(folders: HostWorkspaceFolders): WorkspaceForPath {
  const repoName = new Map(folders.repos.map((repo) => [repo.id, repo.displayName]))
  const candidates = [
    ...folders.repos.map((repo) => ({ path: repo.path, key: repo.id, name: repo.displayName })),
    ...folders.worktrees.flatMap((worktree) => {
      const name = repoName.get(worktree.repoId)
      return name === undefined ? [] : [{ path: worktree.path, key: worktree.repoId, name }]
    }),
    ...folders.folderWorkspaces.map((folder) => ({
      path: folder.folderPath,
      key: folderWorkspaceKey(folder.id),
      name: folder.name
    }))
  ]
  // Why an index: a server can be limited to many projects, and the host can hold 1000s of folders.
  const byFolder = new Map<string, { key: string; name: string }>()
  for (const { path, key, name } of candidates) {
    const folder = normalizeRuntimePathForComparison(path)
    if (!byFolder.has(folder)) {
      byFolder.set(folder, { key, name })
    }
  }
  return (projectPath) => {
    for (const folder of comparisonKeyAndParents(normalizeRuntimePathForComparison(projectPath))) {
      const workspace = byFolder.get(folder)
      if (workspace) {
        return workspace
      }
    }
    return null
  }
}
