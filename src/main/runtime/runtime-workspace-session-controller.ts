import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { workspaceSessionPartitionHostId } from '../../shared/workspace-session-partition-owner'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeWorkspaceSessionDependencies = {
  getStore: () => RuntimeStore | null
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
  hasRuntimeOwnedPtyCandidate: (
    session: WorkspaceSessionState,
    worktreeId: string,
    tabs: WorkspaceSessionState['tabsByWorktree'][string]
  ) => boolean
}

export class RuntimeWorkspaceSessionController {
  constructor(private readonly deps: RuntimeWorkspaceSessionDependencies) {}

  tryGetHostId(worktreeId: string): ExecutionHostId | null {
    const store = this.deps.getStore()
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const workspace = store
        ?.getFolderWorkspaces?.()
        .find((entry) => entry.id === scope.folderWorkspaceId)
      if (!workspace) {
        return null
      }
      // An explicit host is authoritative for folder workspaces. The connection
      // id is only a legacy fallback for records written before host ids existed.
      if (workspace.executionHostId != null) {
        return parseExecutionHostId(workspace.executionHostId)?.id ?? null
      }
      const connectionId = this.deps.resolveFolderConnectionId(workspace)
      return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
    }
    const resolvedWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
    const repo = store?.getRepo?.(getRepoIdFromWorktreeId(resolvedWorktreeId))
    // Why: SSH worktrees keep their own `ssh:<targetId>` partition here while the renderer writes
    // them to 'local'; the shared owner map records that divergence (#12723).
    return repo
      ? workspaceSessionPartitionHostId(getRepoExecutionHostId(repo), 'host-partition')
      : LOCAL_EXECUTION_HOST_ID
  }

  getHostId(worktreeId: string): ExecutionHostId {
    const hostId = this.tryGetHostId(worktreeId)
    if (!hostId) {
      throw new Error('folder_workspace_not_found')
    }
    return hostId
  }

  get(worktreeId: string): WorkspaceSessionState | null {
    const hostId = this.tryGetHostId(worktreeId)
    return hostId ? (this.deps.getStore()?.getWorkspaceSession?.(hostId) ?? null) : null
  }

  set(worktreeId: string, session: WorkspaceSessionState): void {
    this.deps.getStore()?.setWorkspaceSession?.(session, this.getHostId(worktreeId))
  }

  getKnownWorktreeIds(): Set<string> {
    const store = this.deps.getStore()
    const repos = store?.getRepos?.() ?? []
    const repoIds = new Set(repos.map((repo) => repo.id))
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    const worktreeIds = new Set<string>()
    for (const hostId of hostIds) {
      const session = store?.getWorkspaceSession?.(hostId)
      for (const worktreeId of Object.keys(session?.tabsByWorktree ?? {})) {
        if (repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
          worktreeIds.add(worktreeId)
        }
      }
    }
    return worktreeIds
  }

  getHydrationTargets(includeAllPersistedWorktrees: boolean): Map<string, WorkspaceSessionState> {
    const store = this.deps.getStore()
    const repos = store?.getRepos?.() ?? []
    const repoHostIdByRepoId = new Map(
      repos.map((repo) => [repo.id, getRepoExecutionHostId(repo)] as const)
    )
    const folderHostIdByWorkspaceId = new Map(
      (store?.getFolderWorkspaces?.() ?? []).map((workspace) => {
        const explicitHostId =
          workspace.executionHostId != null
            ? (parseExecutionHostId(workspace.executionHostId)?.id ?? null)
            : null
        const connectionId = explicitHostId ? null : this.deps.resolveFolderConnectionId(workspace)
        return [
          workspace.id,
          explicitHostId ??
            (connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID)
        ] as const
      })
    )
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }

    const targets = new Map<string, WorkspaceSessionState>()
    for (const hostId of hostIds) {
      const session = store?.getWorkspaceSession?.(hostId)
      if (!session) {
        continue
      }
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        const scope = parseWorkspaceKey(worktreeId)
        const ownerHostId =
          scope?.type === 'folder'
            ? (folderHostIdByWorkspaceId.get(scope.folderWorkspaceId) ?? null)
            : (repoHostIdByRepoId.get(
                getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : worktreeId)
              ) ?? LOCAL_EXECUTION_HOST_ID)
        if (
          ownerHostId === hostId &&
          (includeAllPersistedWorktrees ||
            this.deps.hasRuntimeOwnedPtyCandidate(session, worktreeId, tabs))
        ) {
          targets.set(worktreeId, session)
        }
      }
    }
    return targets
  }
}
