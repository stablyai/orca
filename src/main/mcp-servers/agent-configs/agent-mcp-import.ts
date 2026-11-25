// "In your agents": list the servers agents keep in their own configs, and Move or Copy one into
// Orca's host list. Move adds first, then takes the entries out of the agents' files, so a failed
// removal never loses the server.
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { botToolDetail, type BotToolServer } from '../../../shared/bot-tools'
import { agentMcpServerMergeKey } from '../../../shared/mcp/agent-mcp-config-entry'
import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
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

export type AgentMcpServerRow = {
  key: string
  name: string
  detail: string
  transport: 'http' | 'command'
  agents: string[]
  files: string[]
  /** The repos or folders a project-limited server (Claude's local scope) is for; empty otherwise. */
  projectNames: string[]
  movable: boolean
}

/** Only these workspaces; null keeps a server on everywhere. */
export type AgentMcpServerWorkspaces = { later: false; on: string[]; off: [] } | null

/** The host's workspace key and name for a project folder, or null when Orca doesn't know it. */
export type WorkspaceForPath = (projectPath: string) => { key: string; name: string } | null

export type ImportedMcpServerScope = {
  workspaces: AgentMcpServerWorkspaces
  /** Agents whose own copy was switched off: the server stays off for them in Orca. */
  agentsOff: string[]
}

export type AddImportedMcpServer<T> = (
  server: BotToolServer,
  scope: ImportedMcpServerScope
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
  workspaceFor: WorkspaceForPath
  /** Claude projects Orca made itself (bots' sign-in folders), never the user's. */
  isOrcaProject: (projectPath: string) => boolean
}

export function localAgentMcpImportHost(
  userDataPath: string,
  workspaceFor: WorkspaceForPath
): AgentMcpImportHost {
  return {
    context: { homeDir: homedir(), env: process.env, platform: process.platform },
    userDataPath,
    workspaceFor,
    isOrcaProject: isOrcaDataProject
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
  row: AgentMcpServerRow
  scope: ImportedMcpServerScope
}

function importRow(found: DiscoveredAgentMcpServer, workspaceFor: WorkspaceForPath): ImportRow {
  const projectPaths = found.sources.map((source) => source.projectPath)
  // One unscoped copy means every workspace already gets it.
  const limited = projectPaths.every((path) => path !== undefined)
  const mapped = limited
    ? projectPaths.map((path) => ({ path: path!, workspace: workspaceFor(path!) }))
    : []
  const keys = [...new Set(mapped.flatMap(({ workspace }) => (workspace ? [workspace.key] : [])))]
  const agents = [...new Set(found.sources.map((source) => source.agent))]
  return {
    found,
    scope: {
      workspaces: limited ? { later: false, on: keys, off: [] } : null,
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
      files: [...new Set(found.sources.map((source) => source.path))],
      projectNames: [
        ...new Set(mapped.map(({ path, workspace }) => workspace?.name ?? basename(path)))
      ],
      movable:
        found.sources.every((source) => source.scope === 'user') &&
        mapped.every(({ workspace }) => workspace !== null)
    }
  }
}

async function importRows(host: AgentMcpImportHost): Promise<ImportRow[]> {
  const found = await discoverAgentMcpServers(host.context, host.isOrcaProject)
  return found.map((server) => importRow(server, host.workspaceFor))
}

export async function listAgentMcpServers(host: AgentMcpImportHost): Promise<AgentMcpServerRow[]> {
  return (await importRows(host)).map(({ row }) => row)
}

async function movableRow(host: AgentMcpImportHost, key: string): Promise<ImportRow> {
  const found = (await importRows(host)).find(({ row }) => row.key === key)
  if (!found) {
    throw new AgentMcpServerImportError('gone')
  }
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
  const { found, scope } = await movableRow(host, key)
  return add(found.server, scope)
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
 * from every agent file listed and from Orca's Claude account profiles, keeping a backup of each.
 */
export async function moveAgentMcpServer<T>(
  host: AgentMcpImportHost,
  key: string,
  add: AddImportedMcpServer<T>
): Promise<T> {
  const { found, scope } = await movableRow(host, key)
  const added = await add(found.server, scope)
  const configName = found.sources[0]!.keyPath.at(-1)!
  const mergeKey = agentMcpServerMergeKey(configName, found.server)
  await removeAgentMcpServerEntries(found.sources, mergeKey)
  try {
    // A profile entry the user changed in that account is theirs to keep.
    await removeAgentMcpServerEntries(await claudeProfileCopies(host, found.sources), mergeKey, {
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
}

export type HostWorkspaceFolders = {
  repos: readonly { id: string; path: string; displayName: string }[]
  worktrees: readonly { repoId: string; path: string }[]
  folderWorkspaces: readonly { id: string; name: string; folderPath: string }[]
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
  return (projectPath) =>
    candidates
      .filter((candidate) => isPathInsideOrEqual(candidate.path, projectPath))
      .sort((left, right) => right.path.length - left.path.length)
      .map(({ key, name }) => ({ key, name }))[0] ?? null
}
