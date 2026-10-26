import { WORKSPACE_ON_OTHER_RUNTIME } from '../../shared/protocol-version'
import { refreshAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import { captureHostShellEnvironment } from '../runtime/structured-agent-shell-environment'
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
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { resolveWorktreeHostRouting } from '../runtime/worktree-launch-host-repo'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import {
  detectInstalledAgentsWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  type RefreshAgentsResult
} from './agent-detection'

export type AgentDetectionHost =
  | { kind: 'local'; context?: PreflightRuntimeContext }
  | { kind: 'ssh'; connectionId: string }

export type WorkspaceAgentDetectionStore = ProjectRuntimeResolutionStore & {
  getRepos?: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getProjectGroups?: () => ProjectGroup[]
}

export const HOST_DEFAULT_AGENT_DETECTION: AgentDetectionHost = { kind: 'local' }

export type AgentDetectionWorkspace =
  | { kind: 'folder'; folderWorkspaceId: string }
  | { kind: 'worktree'; repoId: string; path: string; hostId?: string | null }

type ResolvedWorkspace =
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'local'; repo: Repo; path: string }

/** Resolve from host-owned workspace settings; unplaced workspaces retain the legacy host default. */
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
  // Same repo IDs can exist on several hosts; resolve the worktree owner rather than take the first.
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
  // Another runtime's CLI list cannot describe this workspace.
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
  // Multi-repo folders have no unique project runtime to choose.
  const repo = candidates.length === 1 ? candidates[0] : undefined
  return host.kind === 'local' &&
    folder &&
    repo &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    ? { kind: 'local', repo, path: folder.folderPath }
    : null
}

export async function detectAgentsOnHost(host: AgentDetectionHost): Promise<string[]> {
  // Unserved hosts are unverifiable; [] would falsely cache no installed agents.
  if (host.kind === 'ssh') {
    throw new SshHostNotServedError(host.connectionId)
  }
  return detectInstalledAgentsWithShellPathHydration(host.context)
}

const agentRefreshListeners = new Set<() => void>()

export function onAgentsRefreshedOnHost(listener: () => void): () => void {
  agentRefreshListeners.add(listener)
  return () => agentRefreshListeners.delete(listener)
}

export async function refreshAgentsOnHost(host: AgentDetectionHost): Promise<RefreshAgentsResult> {
  if (host.kind === 'ssh') {
    throw new SshHostNotServedError(host.connectionId)
  }
  const wsl = getPreflightWslTarget(host.context)
  const refresh = async (): Promise<RefreshAgentsResult> => {
    const result = await refreshShellPathAndDetectAgents(host.context)
    if (!wsl) {
      await captureHostShellEnvironment()
    }
    agentRefreshListeners.forEach((listener) => listener())
    return result
  }
  return wsl ? refresh() : refreshAtRestCommandContext(refresh)
}
