import { WORKSPACE_ON_OTHER_RUNTIME } from '../../shared/protocol-version'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost
} from '../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  resolveLocalWorkspaceRuntime,
  type ProjectRuntimeResolutionStore
} from '../local-project-runtime-resolution'
import type { PreflightRuntimeContext } from '../ipc/preflight-runtime-target'
import { resolveWorktreeHostRouting } from '../runtime/worktree-launch-host-repo'
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

export const HOST_DEFAULT_AGENT_DETECTION: AgentDetectionHost = { kind: 'local' }

/** A workspace as this host knows it: a folder workspace, or a worktree read from its own list. */
export type AgentDetectionWorkspace =
  | { kind: 'folder'; folderWorkspaceId: string }
  | { kind: 'worktree'; repoId: string; path: string; hostId?: string | null }

type ResolvedWorkspace =
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'local'; repo: Repo; path: string }

/**
 * The host a workspace's agents run on, resolved on this machine from its own project settings.
 * A workspace this store cannot place keeps the host default older clients rely on.
 */
export function resolveWorkspaceAgentDetectionHost(
  store: WorkspaceAgentDetectionStore,
  workspace: AgentDetectionWorkspace
): AgentDetectionHost {
  const resolved =
    workspace.kind === 'folder'
      ? resolveFolderWorkspace(store, workspace.folderWorkspaceId)
      : resolveWorktree(store, workspace)
  if (!resolved) {
    return HOST_DEFAULT_AGENT_DETECTION
  }
  if (resolved.kind === 'ssh') {
    return resolved
  }
  const projectRuntime = resolveLocalWorkspaceRuntime(store, resolved.repo, resolved.path)
  return projectRuntime
    ? { kind: 'local', context: { projectRuntime } }
    : HOST_DEFAULT_AGENT_DETECTION
}

function resolveWorktree(
  store: WorkspaceAgentDetectionStore,
  worktree: Extract<AgentDetectionWorkspace, { kind: 'worktree' }>
): ResolvedWorkspace | null {
  // Why the shared rule: one repo id can name rows on several hosts, and the first row is not
  // necessarily this worktree's owner.
  const routing = resolveWorktreeHostRouting(store.getRepos?.() ?? [], worktree)
  if (routing.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  if (routing.kind === 'unowned') {
    return null
  }
  const sshTargetId = getSshTargetIdForExecutionHost(routing.hostId)
  if (sshTargetId) {
    return { kind: 'ssh', connectionId: sshTargetId }
  }
  // Why refuse: another runtime's worktree is not this host's to probe, and its list would mislead.
  if (parseExecutionHostId(routing.hostId)?.kind === 'runtime') {
    throw new Error(WORKSPACE_ON_OTHER_RUNTIME)
  }
  return routing.hostId === LOCAL_EXECUTION_HOST_ID && routing.repo
    ? { kind: 'local', repo: routing.repo, path: worktree.path }
    : null
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
  if (host.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  if (host.kind === 'runtime') {
    throw new Error(WORKSPACE_ON_OTHER_RUNTIME)
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
