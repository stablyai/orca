import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost
} from '../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  resolveLocalWorkspaceRuntime,
  type ProjectRuntimeResolutionStore
} from '../local-project-runtime-resolution'
import type { PreflightRuntimeContext } from '../ipc/preflight-runtime-target'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents,
  refreshShellPathAndDetectAgents,
  type RefreshAgentsResult
} from './agent-detection'

/** Where agent CLIs are probed: this machine (optionally inside a WSL distro) or an SSH target. */
export type AgentDetectionHost =
  | { kind: 'local'; context?: PreflightRuntimeContext }
  | { kind: 'ssh'; connectionId: string }

export type WorkspaceAgentDetectionStore = ProjectRuntimeResolutionStore & {
  getRepos?: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getProjectGroups?: () => ProjectGroup[]
}

const HOST_DEFAULT: AgentDetectionHost = { kind: 'local' }

type ResolvedWorkspace =
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'local'; repo: Repo; path: string }

/**
 * The host a workspace's agents run on, resolved on this machine from its own project settings.
 * No workspace (or one this store does not know) keeps the host default older clients rely on.
 */
export function resolveWorkspaceAgentDetectionHost(
  store: WorkspaceAgentDetectionStore | undefined,
  worktreeId: string | null | undefined
): AgentDetectionHost {
  if (!store || !worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return HOST_DEFAULT
  }
  const workspace = resolveWorkspace(store, worktreeId)
  if (!workspace) {
    return HOST_DEFAULT
  }
  if (workspace.kind === 'ssh') {
    return workspace
  }
  const projectRuntime = resolveLocalWorkspaceRuntime(store, workspace.repo, workspace.path)
  return projectRuntime ? { kind: 'local', context: { projectRuntime } } : HOST_DEFAULT
}

function resolveWorkspace(
  store: WorkspaceAgentDetectionStore,
  worktreeId: string
): ResolvedWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return resolveFolderWorkspace(store, scope.folderWorkspaceId)
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repo = parsed ? store.getRepo?.(parsed.repoId) : undefined
  if (!parsed || !repo) {
    return null
  }
  const sshTargetId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
  return sshTargetId
    ? { kind: 'ssh', connectionId: sshTargetId }
    : { kind: 'local', repo, path: parsed.worktreePath }
}

function resolveFolderWorkspace(
  store: WorkspaceAgentDetectionStore,
  folderWorkspaceId: string
): ResolvedWorkspace | null {
  const state = {
    folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
    projectGroups: store.getProjectGroups?.() ?? [],
    repos: store.getRepos?.() ?? []
  }
  const host = resolveFolderWorkspaceHost(state, folderWorkspaceId)
  if (host.kind === 'ssh') {
    return { kind: 'ssh', connectionId: host.targetId }
  }
  const folder = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  const candidates = findFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
  // Why one candidate: a folder spanning several repos has no single project runtime to pick.
  const repo = candidates.length === 1 ? candidates[0] : undefined
  return host.kind === 'local' &&
    folder &&
    repo &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    ? { kind: 'local', repo, path: folder.folderPath }
    : null
}

/** The one agent-detection entry point: IPC, runtime RPC, and SSH all probe through here. */
export function detectAgentsOnHost(host: AgentDetectionHost): Promise<string[]> {
  return host.kind === 'ssh'
    ? detectRemoteAgents({ connectionId: host.connectionId })
    : detectInstalledAgentsWithShellPathHydration(host.context)
}

export async function refreshAgentsOnHost(host: AgentDetectionHost): Promise<RefreshAgentsResult> {
  if (host.kind === 'local') {
    return refreshShellPathAndDetectAgents(host.context)
  }
  // Why: an SSH probe already reads the target's fresh login PATH; there is no local PATH to merge.
  return {
    agents: await detectRemoteAgents({ connectionId: host.connectionId }),
    addedPathSegments: [],
    shellHydrationOk: true,
    pathSource: 'sync_seed_only',
    pathFailureReason: 'none'
  }
}
