import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { ProjectLaunchContext } from '../../shared/rpc-contract/preflight/preflight-params'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../shared/remote-runtime/protocol/preflight-runtime-capabilities'
import { refreshAtRestCommandContext } from '../native-chat/agent-session-wire/options/at-rest-command-context'
import { captureHostShellEnvironment } from '../runtime/agent-session/environment/structured-agent-shell-environment'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../shared/execution-host/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type QualifiedFolderWorkspaceSelection
} from '../../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import type { Repo } from '../../shared/repository/repo-types'
import {
  resolveLocalProjectRuntimeForProject,
  resolveLocalWorkspaceRuntime,
  type ProjectRuntimeResolutionStore
} from '../workspaces/execution-host/local-project-runtime-resolution'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import {
  resolveWorktreeHostRouting,
  type WorktreeHostRouting
} from '../runtime/workspaces/catalog/worktree-launch-host-repo'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import {
  detectInstalledAgentsWithShellPathHydration,
  refreshAgentShellPath,
  type RefreshAgentsResult
} from './agent-detection'
import {
  agentCommandOverrideDetectionOptions,
  detectInstalledAgentInventory,
  detectInstalledAgentInventoryWithShellPathHydration,
  type InstalledAgentDetectionOptions,
  type InstalledAgentInventory,
  type InstalledAgentListPolicy
} from './installed-agent-detection'
import { assertWslDistroRunningForExec } from '../wsl/discovery/wsl-background-exec-gate'
import { notifyAgentsRefreshedOnHost } from './agents-refreshed-on-host'
import { AgentInventoryDeadlineError, withAgentInventoryDeadline } from './agent-command-detection'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'

export type AgentDetectionHost =
  | { kind: 'local'; context?: PreflightRuntimeContext }
  | { kind: 'ssh'; connectionId: string }

export type WorkspaceAgentDetectionStore = ProjectRuntimeResolutionStore & {
  getRepos?: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getProjectGroups?: () => ProjectGroup[]
}

export const HOST_DEFAULT_AGENT_DETECTION: AgentDetectionHost = { kind: 'local' }

/** The configured Windows Agent runtime, which desktop probes with nothing focused (#18837). */
export function resolveConfiguredWindowsAgentDetectionHost(
  store: WorkspaceAgentDetectionStore
): AgentDetectionHost {
  if (process.platform !== 'win32' || !store.getSettings?.().localWindowsRuntimeDefault) {
    return HOST_DEFAULT_AGENT_DETECTION
  }
  // 'local-project' is the renderer's id for a runtime resolved without a project.
  const projectRuntime = resolveLocalProjectRuntimeForProject(store, {
    id: 'local-project',
    localWindowsRuntimePreference: { kind: 'inherit-global' }
  })
  return projectRuntime
    ? { kind: 'local', context: { projectRuntime } }
    : HOST_DEFAULT_AGENT_DETECTION
}

export type AgentDetectionWorkspace =
  | {
      kind: 'folder'
      folderWorkspaceId: string
      selected?: QualifiedFolderWorkspaceSelection
    }
  | { kind: 'worktree'; repoId: string; path: string; hostId?: string | null }

type ResolvedWorkspace =
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'local'; repo: Repo; path: string }

/** Resolve from host-owned workspace settings; unplaced workspaces retain the legacy host default. */
export function resolveWorkspaceAgentDetectionHost(
  store: WorkspaceAgentDetectionStore,
  workspace: AgentDetectionWorkspace,
  worktreeRouting?: WorktreeHostRouting<Repo>
): AgentDetectionHost {
  const resolved =
    workspace.kind === 'folder'
      ? resolveFolderWorkspace(store, workspace.folderWorkspaceId, workspace.selected)
      : resolveWorktree(store, workspace, worktreeRouting)
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
  worktree: Extract<AgentDetectionWorkspace, { kind: 'worktree' }>,
  resolvedRouting?: WorktreeHostRouting<Repo>
): ResolvedWorkspace | null {
  // Same repo IDs can exist on several hosts; resolve the worktree owner rather than take the first.
  const routing = resolvedRouting ?? resolveWorktreeHostRouting(store.getRepos?.() ?? [], worktree)
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
  folderWorkspaceId: string,
  selected?: QualifiedFolderWorkspaceSelection
): ResolvedWorkspace | null {
  if (selected && selected.workspace.id !== folderWorkspaceId) {
    throw new Error('worktree_execution_host_unresolved')
  }
  const state = {
    folderWorkspaces: selected ? [selected.workspace] : (store.getFolderWorkspaces?.() ?? []),
    projectGroups: store.getProjectGroups?.() ?? [],
    repos: store.getRepos?.() ?? []
  }
  const host = selected
    ? parseExecutionHostId(selected.hostId)
    : resolveFolderWorkspaceHost(state, folderWorkspaceId)
  if (!host) {
    throw new Error('worktree_execution_host_unresolved')
  }
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

export async function detectAgentsOnHost(
  host: AgentDetectionHost,
  options?: InstalledAgentDetectionOptions,
  signal?: AbortSignal,
  policy: InstalledAgentListPolicy = 'complete'
): Promise<string[]> {
  // Unserved hosts are unverifiable; [] would falsely cache no installed agents.
  if (host.kind === 'ssh') {
    throw new SshHostNotServedError(host.connectionId)
  }
  return detectInstalledAgentsWithShellPathHydration(host.context, options, signal, policy)
}

/** The host's terminal agents and user CLI paths outside PATH. */
export async function detectAgentInventoryOnHost(
  host: AgentDetectionHost,
  options?: InstalledAgentDetectionOptions,
  signal?: AbortSignal
): Promise<InstalledAgentInventory> {
  if (host.kind === 'ssh') {
    throw new SshHostNotServedError(host.connectionId)
  }
  return detectInstalledAgentInventoryWithShellPathHydration(host.context, options, signal)
}

/** Background detection in a WSL runtime refuses a stopped distro (E9); a user act for it passes. */
export async function assertAgentDetectionHostRunning(host: AgentDetectionHost): Promise<void> {
  const wslTarget = host.kind === 'local' ? getPreflightWslTarget(host.context) : null
  if (wslTarget) {
    await assertWslDistroRunningForExec(wslTarget.distro)
  }
}

export async function refreshAgentsOnHost(
  host: AgentDetectionHost,
  options?: InstalledAgentDetectionOptions,
  userInitiated = false,
  withManagedAgentCommands = false,
  requestSignal?: AbortSignal
): Promise<RefreshAgentsResult> {
  if (host.kind === 'ssh') {
    throw new SshHostNotServedError(host.connectionId)
  }
  const wsl = getPreflightWslTarget(host.context)
  let path: Awaited<ReturnType<typeof refreshAgentShellPath>> | undefined
  let waitSignal: AbortSignal | undefined
  const inventory = await detectInstalledAgentInventory(
    host.context,
    { ...options, waitForCompletion: userInitiated },
    true,
    requestSignal,
    async (signal) => {
      waitSignal = signal
      const preparePath = () => refreshAgentShellPath(host.context, signal)
      path = wsl
        ? await preparePath()
        : await waitForPromiseWithSignal(
            refreshAtRestCommandContext(() => {
              throwIfSignalAborted(signal)
              return captureHostShellEnvironment(preparePath)
            }),
            signal
          )
    }
  )
  if (!waitSignal?.aborted) {
    notifyAgentsRefreshedOnHost(userInitiated && !wsl)
  }
  if (inventory.incomplete && !withManagedAgentCommands) {
    throw new AgentInventoryDeadlineError(inventory.afterPublication)
  }
  return {
    ...inventory,
    ...(path ?? {
      addedPathSegments: [],
      shellHydrationOk: false,
      pathSource: 'sync_seed_only',
      pathFailureReason: 'timeout'
    })
  }
}

/** A prospective workspace uses the create route's resolved repo, never a client host guess. */
export async function detectProjectLaunchContext(
  store: WorkspaceAgentDetectionStore,
  repo: Repo,
  onlyTuiAgent?: TuiAgent,
  { detect, signal }: { detect?: typeof detectAgentsOnHost; signal?: AbortSignal } = {}
): Promise<ProjectLaunchContext> {
  const host = getRepoExecutionHostId(repo)
  const ssh = getSshTargetIdForExecutionHost(host)
  if (parseExecutionHostId(host)?.kind === 'runtime') {
    throw new Error(WORKSPACE_ON_OTHER_RUNTIME)
  }
  const projectRuntime = ssh ? undefined : resolveLocalWorkspaceRuntime(store, repo, repo.path)
  if (!ssh && !projectRuntime) {
    throw new Error('worktree_execution_host_unresolved')
  }
  const overrides = agentCommandOverrideDetectionOptions(store.getSettings?.().agentCmdOverrides)
  const options = onlyTuiAgent ? { ...overrides, onlyTuiAgent } : overrides
  const context = { projectRuntime }
  const { agents, incomplete } = await withAgentInventoryDeadline(async (waitSignal) => {
    const target: AgentDetectionHost = ssh
      ? { kind: 'ssh', connectionId: ssh }
      : { kind: 'local', context }
    const detected: InstalledAgentInventory = detect
      ? { agents: await detect(target, options, waitSignal) }
      : await detectAgentInventoryOnHost(target, options, waitSignal)
    return !ssh && onlyTuiAgent && !detected.incomplete && !detected.agents.includes(onlyTuiAgent)
      ? detectInstalledAgentInventory(context, options, true, waitSignal)
      : detected
  }, signal)
  return {
    agents: agents.filter(isTuiAgent),
    ...(incomplete ? { incomplete: true } : {}),
    workspaceKind: isFolderRepo(repo) ? 'folder' : 'git-worktree',
    executionContext: projectRuntime ? { kind: 'host', projectRuntime } : { kind: 'ssh' }
  }
}
