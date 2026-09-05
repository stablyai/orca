import type { ProjectHostSetup, ProjectHostSetupUpdateArgs } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  removeRepoFromHostWorkspaceSessions,
  removeRepoFromWorkspaceSession
} from '../../orca-profiles/profile-project-session-state'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { mergeProjectHostSetupCompatibilityState } from '../tracking-repos/project-host-compatibility'
import { RepoOrderPersistenceOperations } from '../tracking-repos/repo-order-operations'
import { pruneWorktreeStateForRepo as pruneWorktreeStateForRepoOperation } from '../tracking-repos/repo-worktree-pruning'
import { collectDeregisteredRepoIds } from '../tracking-repos/deregistered-repo-residue'
import { retireLocalWorktreeMetadataPruneStateForRepo } from '../../local-worktree-metadata-prune-gate'
import { hydrateRepo as hydrateRepoOperation } from '../tracking-repos/repo-hydration'
import { RepoUpdatePersistenceOperations } from '../tracking-repos/repo-update-operations'
import { ProjectHostSetupPersistenceOperations } from '../tracking-repos/project-host-setup-update'
import { bumpLocalWorktreeScanGeneration } from '../../local-worktree-scan-generation'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type RepoLifecycleOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'gitUsernameCache'
  | 'projectHostSetupOperations'
  | 'repoOrderOperations'
  | 'repoUpdateOperations'
  | 'state'
>

const repoLifecycleOperationsContext = Symbol('RepoLifecycleOperations')
type RepoLifecycleOperationsContext = {
  runtime: RepoLifecycleOperationsRuntime
  scheduling: WriteSchedulingOperations
}

export class RepoLifecycleOperations {
  readonly [repoLifecycleOperationsContext]: RepoLifecycleOperationsContext

  constructor(runtime: RepoLifecycleOperationsRuntime, scheduling: WriteSchedulingOperations) {
    this[repoLifecycleOperationsContext] = { runtime, scheduling }
  }

  addRepo(repo: Repo): void {
    bumpLocalWorktreeScanGeneration(repo.id)
    getRepoOrderOperations(this).addRepo(repo)
  }

  reorderRepos(orderedIds: string[]): boolean {
    return getRepoOrderOperations(this).reorderRepos(orderedIds)
  }

  reorderReposForHost(orderedIds: string[], hostId: ExecutionHostId): boolean {
    return getRepoOrderOperations(this).reorderReposForHost(orderedIds, hostId)
  }

  removeProject(id: string): void {
    const repoRemoved = this[repoLifecycleOperationsContext].runtime.state.repos.some(
      (repo) => repo.id === id
    )
    this[repoLifecycleOperationsContext].runtime.state.repos = this[
      repoLifecycleOperationsContext
    ].runtime.state.repos.filter((r) => r.id !== id)
    if (repoRemoved) {
      bumpLocalWorktreeScanGeneration(id)
    }
    syncProjectHostSetupCompatibilityState(this)
    // Why: presets are repo-scoped and unreachable once the repo is gone, so drop them with it.
    delete this[repoLifecycleOperationsContext].runtime.state.sparsePresetsByRepo[id]
    delete this[repoLifecycleOperationsContext].runtime.state.retiredWorktreeNamesByRepo?.[id]
    pruneWorktreeStateForRepo(this, id, null)
    this[repoLifecycleOperationsContext].runtime.state.workspaceSession =
      removeRepoFromWorkspaceSession(
        this[repoLifecycleOperationsContext].runtime.state.workspaceSession,
        id
      )
    this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId =
      removeRepoFromHostWorkspaceSessions(
        this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId,
        id
      )
    scheduleSave(this[repoLifecycleOperationsContext].scheduling)
  }

  removeProjectForHost(id: string, hostId: ExecutionHostId): void {
    const repoRemoved = this[repoLifecycleOperationsContext].runtime.state.repos.some(
      (repo) => repo.id === id && getRepoExecutionHostId(repo) === hostId
    )
    this[repoLifecycleOperationsContext].runtime.state.repos = this[
      repoLifecycleOperationsContext
    ].runtime.state.repos.filter((r) => !(r.id === id && getRepoExecutionHostId(r) === hostId))
    if (repoRemoved) {
      bumpLocalWorktreeScanGeneration(id)
    }
    const idStillPresent = this[repoLifecycleOperationsContext].runtime.state.repos.some(
      (r) => r.id === id
    )
    // Why: presets and retirements are repo-id-scoped (not host-scoped); drop them only when the last host's copy is gone.
    if (!idStillPresent) {
      delete this[repoLifecycleOperationsContext].runtime.state.sparsePresetsByRepo[id]
      delete this[repoLifecycleOperationsContext].runtime.state.retiredWorktreeNamesByRepo?.[id]
    }
    syncProjectHostSetupCompatibilityState(this)
    // Why: prune only this host's worktree metas if the id survives elsewhere; otherwise prune everything (matches removeProject).
    pruneWorktreeStateForRepo(this, id, idStillPresent ? hostId : null)
    if (!idStillPresent) {
      this[repoLifecycleOperationsContext].runtime.state.workspaceSession =
        removeRepoFromWorkspaceSession(
          this[repoLifecycleOperationsContext].runtime.state.workspaceSession,
          id
        )
      this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId =
        removeRepoFromHostWorkspaceSessions(
          this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId,
          id
        )
    } else if (parseExecutionHostId(hostId)?.kind === 'runtime') {
      const session =
        this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId?.[hostId]
      if (session) {
        this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId = {
          ...this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId,
          [hostId]: removeRepoFromWorkspaceSession(session, id)
        }
      }
    }
    scheduleSave(this[repoLifecycleOperationsContext].scheduling)
  }

  /**
   * Drop every persisted row owned by a repo id that is no longer registered.
   *
   * Runs at load because no removal path can: `removeProject` only fires while the repo is still in
   * `state.repos`, and a paired client's mirror of a remote host's rows is keyed by ids that client
   * never registers, so the owning host's removal never reaches it (#17776). An orphan has no owner
   * that could object, so this ignores the session-ownership and local-execution-host gates the
   * missing-directory sweeper needs.
   */
  sweepDeregisteredRepoResidue(): string[] {
    const state = this[repoLifecycleOperationsContext].runtime.state
    const orphanRepoIds = collectDeregisteredRepoIds(state)
    if (orphanRepoIds.size === 0) {
      return []
    }
    for (const repoId of orphanRepoIds) {
      pruneWorktreeStateForRepo(this, repoId, null)
      state.workspaceSession = removeRepoFromWorkspaceSession(state.workspaceSession, repoId)
      state.workspaceSessionsByHostId = removeRepoFromHostWorkspaceSessions(
        state.workspaceSessionsByHostId,
        repoId
      )
    }
    pruneDeregisteredRepoUiResidue(state.ui, orphanRepoIds)
    return [...orphanRepoIds]
  }

  updateRepo(
    id: string,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'repoIcon'
        | 'upstream'
        | 'gitRemoteIdentity'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'worktreeBasePath'
        | 'kind'
        | 'executionHostId'
        | 'symlinkPaths'
        | 'issueSourcePreference'
        | 'forkSyncMode'
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeInboxBaselinePaths'
        | 'importedExternalWorktreePaths'
        | 'customWorktreeVisibilitySources'
        | 'worktreeVisibilitySourcePreferences'
        | 'projectGroupId'
        | 'projectGroupOrder'
        | 'projectHostSetupMethod'
      >
    > & {
      externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
      agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
    },
    hostId?: ExecutionHostId
  ): Repo | null {
    return getRepoUpdateOperations(this).updateRepo(id, updates, hostId)
  }
}

export function getRepoOrderOperations(
  owner: RepoLifecycleOperations
): RepoOrderPersistenceOperations {
  owner[repoLifecycleOperationsContext].runtime.repoOrderOperations ??=
    new RepoOrderPersistenceOperations({
      state: owner[repoLifecycleOperationsContext].runtime.state,
      syncProjectHostSetupCompatibilityState: () => syncProjectHostSetupCompatibilityState(owner),
      scheduleSave: () => scheduleSave(owner[repoLifecycleOperationsContext].scheduling)
    })
  return owner[repoLifecycleOperationsContext].runtime.repoOrderOperations
}

export function pruneWorktreeStateForRepo(
  owner: RepoLifecycleOperations,
  id: string,
  hostId: ExecutionHostId | null
): void {
  pruneWorktreeStateForRepoOperation(
    owner[repoLifecycleOperationsContext].runtime.state,
    id,
    hostId,
    (matchesWorktreeId) => pruneMobileClientTabSelections(owner, matchesWorktreeId)
  )
  // Why: this drops metadata, lineage, leases and session owners in bulk, which can unpin rows in
  // other repos, and a full removal retires this repo's own gate state (#17775).
  retireLocalWorktreeMetadataPruneStateForRepo(id, hostId)
}

export function pruneMobileClientTabSelections(
  owner: RepoLifecycleOperations,
  matchesWorktreeId: (worktreeId: string) => boolean
): void {
  for (const [clientNavigationId, selectionsByWorktree] of Object.entries(
    owner[repoLifecycleOperationsContext].runtime.state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    for (const worktreeId of Object.keys(selectionsByWorktree)) {
      if (matchesWorktreeId(worktreeId)) {
        delete selectionsByWorktree[worktreeId]
      }
    }
    if (Object.keys(selectionsByWorktree).length === 0) {
      delete owner[repoLifecycleOperationsContext].runtime.state
        .mobileClientTabSelectionsByDeviceId?.[clientNavigationId]
    }
  }
}

function pruneDeregisteredRepoUiResidue(
  ui: PersistedState['ui'],
  orphanRepoIds: ReadonlySet<string>
): void {
  const isOrphanWorktree = (worktreeId: string): boolean =>
    orphanRepoIds.has(getRepoIdFromWorktreeId(worktreeId))
  if (ui.lastActiveRepoId && orphanRepoIds.has(ui.lastActiveRepoId)) {
    ui.lastActiveRepoId = null
  }
  if (ui.lastActiveWorktreeId && isOrphanWorktree(ui.lastActiveWorktreeId)) {
    ui.lastActiveWorktreeId = null
  }
  ui.filterRepoIds = ui.filterRepoIds?.filter((repoId) => !orphanRepoIds.has(repoId)) ?? []
  for (const worktreeId of Object.keys(ui.showDotfilesByWorktree ?? {})) {
    if (isOrphanWorktree(worktreeId)) {
      delete ui.showDotfilesByWorktree?.[worktreeId]
    }
  }
}

export function getRepoUpdateOperations(
  owner: RepoLifecycleOperations
): RepoUpdatePersistenceOperations {
  owner[repoLifecycleOperationsContext].runtime.repoUpdateOperations ??=
    new RepoUpdatePersistenceOperations({
      state: owner[repoLifecycleOperationsContext].runtime.state,
      bumpLocalWorktreeScanGeneration,
      syncProjectHostSetupCompatibilityState: () => syncProjectHostSetupCompatibilityState(owner),
      scheduleSave: () => scheduleSave(owner[repoLifecycleOperationsContext].scheduling),
      hydrateRepo: (repo) => hydrateRepo(owner, repo)
    })
  return owner[repoLifecycleOperationsContext].runtime.repoUpdateOperations
}

export function syncProjectHostSetupCompatibilityState(owner: RepoLifecycleOperations): void {
  const compatibilityState = mergeProjectHostSetupCompatibilityState(
    owner[repoLifecycleOperationsContext].runtime.state,
    owner[repoLifecycleOperationsContext].runtime.state.repos
  )
  owner[repoLifecycleOperationsContext].runtime.state.projects = compatibilityState.projects
  owner[repoLifecycleOperationsContext].runtime.state.projectHostSetups =
    compatibilityState.projectHostSetups
}

export function getProjectHostSetupOperations(
  owner: RepoLifecycleOperations
): ProjectHostSetupPersistenceOperations {
  owner[repoLifecycleOperationsContext].runtime.projectHostSetupOperations ??=
    new ProjectHostSetupPersistenceOperations({
      state: owner[repoLifecycleOperationsContext].runtime.state,
      updateRepo: (id, updates, hostId) => owner.updateRepo(id, updates, hostId),
      scheduleSave: () => scheduleSave(owner[repoLifecycleOperationsContext].scheduling)
    })
  return owner[repoLifecycleOperationsContext].runtime.projectHostSetupOperations
}

export function updateRepoBackedProjectHostSetup(
  owner: RepoLifecycleOperations,
  setup: ProjectHostSetup,
  repo: Repo,
  updates: ProjectHostSetupUpdateArgs['updates']
): { setup: ProjectHostSetup; repo: Repo } | null {
  return getProjectHostSetupOperations(owner).updateRepoBackedProjectHostSetup(setup, repo, updates)
}

export function updateIndependentProjectHostSetup(
  owner: RepoLifecycleOperations,
  setup: ProjectHostSetup,
  updates: ProjectHostSetupUpdateArgs['updates']
): ProjectHostSetup {
  return getProjectHostSetupOperations(owner).updateIndependentProjectHostSetup(setup, updates)
}

export function hydrateRepo(owner: RepoLifecycleOperations, repo: Repo): Repo {
  return hydrateRepoOperation(repo, owner[repoLifecycleOperationsContext].runtime.gitUsernameCache)
}

export function installRepoLifecycleOperationsContext(
  target: object,
  source: RepoLifecycleOperations
): void {
  Object.defineProperty(target, repoLifecycleOperationsContext, {
    value: source[repoLifecycleOperationsContext]
  })
}
