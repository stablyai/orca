import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../shared/worktree/id'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
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

  private getPreferredHostId(worktreeId: string, store: RuntimeStore): ExecutionHostId | null {
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
        const parsedHostId = parseExecutionHostId(workspace.executionHostId)?.id
        if (!parsedHostId) {
          return null
        }
        return parsedHostId
      }
      const connectionId = this.deps.resolveFolderConnectionId(workspace)
      return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
    }
    const resolvedWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
    // Why the singular lookup first: a floating terminal carries no `repoId::path`, and this runs
    // on the mobile hydrate poll path, so enumerating every repo to learn that no row owns the id
    // is pure cost. Same answer either way — an unowned id routes to local (#9343).
    if (!splitWorktreeId(resolvedWorktreeId)) {
      const repo = store.getRepo?.(resolvedWorktreeId)
      return repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
    }
    const repoId = getRepoIdFromWorktreeId(resolvedWorktreeId)
    const repos = store.getRepos?.() ?? []
    const routing = resolveWorktreeHostRouting(repos, { repoId })
    if (routing.kind === 'ambiguous') {
      return null
    }
    return routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
  }

  tryGetHostId(worktreeId: string): ExecutionHostId | null {
    const store = this.deps.getStore()
    // Partition contents cannot prove that two execution hosts are the same host.
    const hostId = store ? this.getPreferredHostId(worktreeId, store) : null
    // Existing callers default a missing partition to local; ambiguity must not take that path.
    if (store && !hostId && parseWorkspaceKey(worktreeId)?.type !== 'folder') {
      throw new Error('worktree_execution_host_unresolved')
    }
    return hostId
  }

  getHostId(worktreeId: string): ExecutionHostId {
    const hostId = this.tryGetHostId(worktreeId)
    if (!hostId) {
      throw new Error(
        parseWorkspaceKey(worktreeId)?.type === 'folder'
          ? 'folder_workspace_not_found'
          : 'worktree_execution_host_unresolved'
      )
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
    if (!store) {
      return new Map()
    }
    const repos = store?.getRepos?.() ?? []
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }

    const targets = new Map<string, WorkspaceSessionState>()
    const sessionsByHostId = new Map<ExecutionHostId, WorkspaceSessionState>()
    for (const hostId of hostIds) {
      const session = store?.getWorkspaceSession?.(hostId)
      if (!session) {
        continue
      }
      sessionsByHostId.set(hostId, session)
    }
    for (const [hostId, session] of sessionsByHostId) {
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        const ownerHostId = this.getPreferredHostId(worktreeId, store)
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
