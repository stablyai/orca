// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from './orca-runtime-transition-graph-reload-to-terminal-state'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import {
  LOCAL_EXECUTION_HOST_ID,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../shared/execution-host'
import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { resolveWorktreeLaunchHost } from './worktree-launch-host-repo'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import type { ResolvedTerminalWorkspaceLaunchTarget } from './orca-runtime-core'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from './orca-runtime-core'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { homedir } from 'node:os'
import { getExplicitWorktreeIdSelector } from './runtime-worktree-selection'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import { WorktreeIdRequiresFullPathError } from './runtime-worktree-lineage-resolution'
import { triggerTerminalSpawnPushTargetMaterialization } from './runtime-terminal-spawn-push-target-materialization'

export class OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree extends OrcaRuntimeWithTransitionGraphReloadToTerminalState {
  protected resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    const repo = worktree?.repoId ? this.requireStore().getRepo(worktree.repoId) : undefined
    const executionHostId = worktree
      ? getWorktreeExecutionHostId(worktree, repo)
      : LOCAL_EXECUTION_HOST_ID
    const parsedHost = parseExecutionHostId(executionHostId)
    return resolveRuntimeBrowserNetworkExecutionHost({
      runtimeId: this.getRuntimeId(),
      runtimeRevision: this.getStartedAt(),
      executionHostId,
      ...(worktree
        ? {
            projectRuntime: resolveLocalProjectRuntimeForWorktreeId(
              this.requireStore(),
              worktree.id
            )
          }
        : {}),
      ...(parsedHost?.kind === 'ssh'
        ? { sshState: getRegisteredSshState(parsedHost.targetId) }
        : {})
    })
  }

  protected async resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string> {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    return parsed?.type === 'folder'
      ? folderWorkspaceKey(parsed.folderWorkspaceId)
      : this.resolveEmulatorWorkspaceId(selector)
  }

  protected folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    return {
      ...worktree,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        isBare: worktree.isBare,
        isMainWorktree: worktree.isMainWorktree
      }
    }
  }

  protected resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined {
    return resolveTerminalStartupCwd(workspace.path, requestedCwd)
  }

  protected async resolveTerminalWorkspaceLaunchScope(
    selector: string
  ): Promise<TerminalWorkspaceLaunchScope> {
    return (await this.resolveTerminalWorkspaceLaunchTarget(selector)).scope
  }

  protected async resolveTerminalWorkspaceLaunchTarget(
    selector: string
  ): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
    const floatingTerminalSelector =
      selector === FLOATING_TERMINAL_WORKTREE_ID ||
      selector === `id:${FLOATING_TERMINAL_WORKTREE_ID}`
    if (floatingTerminalSelector) {
      // Why: the floating sentinel is terminal-only — no backing repo/worktree record for other workspace APIs.
      return {
        scope: {
          id: FLOATING_TERMINAL_WORKTREE_ID,
          path: homedir(),
          connectionId: null,
          repo: null,
          folderWorkspace: null
        },
        managedWorktree: null
      }
    }

    const folderScope = await this.resolveFolderWorkspaceLaunchScope(selector)
    if (folderScope) {
      return {
        scope: folderScope,
        managedWorktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace)
      }
    }

    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    const worktreeSelector = parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    // Why: `getRepo(id)` is host-blind and the same repo id can exist on local, SSH and runtime
    // hosts. Reading `connectionId` off an arbitrary row reports "local" for a remote worktree and
    // spawns its PTY on the client with the remote cwd (#11163). Loss of a usable answer is
    // `unresolved`, never `local`.
    const resolution = resolveWorktreeLaunchHost(this.store?.getRepos() ?? [], worktree)
    if (resolution.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    // Metadata only (display name, hook settings); the routing decision is `resolution.connectionId`.
    const repo = resolution.repo ?? this.store?.getRepo(worktree.repoId) ?? null
    triggerTerminalSpawnPushTargetMaterialization(
      worktree.path,
      worktree.pushTarget,
      repo,
      this.store,
      worktree.repoId,
      worktree.id
    )
    return {
      scope: {
        id: worktree.id,
        path: worktree.path,
        connectionId: resolution.connectionId,
        repo,
        folderWorkspace: null
      },
      managedWorktree: worktree
    }
  }

  protected buildTerminalWorkspaceEnv(
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ): Record<string, string> {
    const cleanBaseEnv = { ...baseEnv }
    for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
      delete cleanBaseEnv[key]
    }
    const env = {
      ...cleanBaseEnv,
      ...agentTeamsEnv,
      ...this.buildAgentHookPtyEnv?.(),
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: tabId,
      ORCA_WORKTREE_ID: scope.id
    }
    if (!scope.folderWorkspace) {
      return env
    }
    return {
      ...env,
      ORCA_WORKSPACE_ID: scope.id,
      ORCA_PROJECT_GROUP_ID: scope.folderWorkspace.projectGroupId,
      ORCA_WORKSPACE_ROOT: scope.folderWorkspace.folderPath
    }
  }

  protected getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    const worktreeId = getExplicitWorktreeIdSelector(selector)
    if (
      worktreeId &&
      !worktreeId.includes(WORKTREE_ID_SEPARATOR) &&
      this.store?.getRepo(worktreeId)
    ) {
      // Why: a registered repo id is a known-invalid worktree id; reject early before fast paths or Git/SSH scans hide the mistake.
      throw new WorktreeIdRequiresFullPathError()
    }
    return worktreeId
  }
}
