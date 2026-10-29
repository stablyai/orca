import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ProjectHostSetup, ProjectHostSetupUpdateArgs } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
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
import {
  bumpLocalWorktreeScanGeneration,
  retireLocalWorktreeScanGeneration
} from '../../local-worktree-scan-generation'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'
import { pruneDeregisteredRepoUiResidue } from './repo-lifecycle-ui-residue'
import { isWslMoveProjectSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import { dropOrcadTerminalRestoreHintsForWorktrees } from '../migrating-orcad-catalog/orcad-terminal-restore-hint-store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { applyNewWindowsDriveProjectDefault } from '../../wsl/wsl-drive-project-new-default'

// A paused WSL move keeps its local rows for a downgrade.
function removeLocalRepoSession(
  session: WorkspaceSessionState,
  repoId: string
): WorkspaceSessionState {
  return isWslMoveProjectSessionFrozen({ repoId })
    ? session
    : removeRepoFromWorkspaceSession(session, repoId)
}
type RepoLifecycleOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'gitUsernameCache'
  | 'projectHostSetupOperations'
  | 'repoOrderOperations'
  | 'repoUpdateOperations'
  | 'state'
  | 'orcadTerminalRestoreHints'
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
    const context = this[repoLifecycleOperationsContext]
    if (applyNewWindowsDriveProjectDefault(context.runtime.state, repo)) {
      scheduleSave(context.scheduling)
    }
  }

  reorderRepos(orderedIds: string[]): boolean {
    return getRepoOrderOperations(this).reorderRepos(orderedIds)
  }

  reorderReposForHost(orderedIds: string[], hostId: ExecutionHostId): boolean {
    return getRepoOrderOperations(this).reorderReposForHost(orderedIds, hostId)
  }

  removeProjectForHost(target: RepoHostTarget): void {
    const id = target.id
    const hostId = getRepoExecutionHostId(target)
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
    if (!idStillPresent) {
      retireLocalWorktreeScanGeneration(id)
      dropRepoRestoreHints(this, id)
      delete this[repoLifecycleOperationsContext].runtime.state.sparsePresetsByRepo[id]
      delete this[repoLifecycleOperationsContext].runtime.state.retiredWorktreeNamesByRepo?.[id]
    }
    syncProjectHostSetupCompatibilityState(this)
    // Paired repos may be absent locally while same-ID rows remain on another host; prune only this host.
    const pairedHost = parseExecutionHostId(hostId)?.kind === 'runtime'
    pruneWorktreeStateForRepo(this, id, idStillPresent || pairedHost ? hostId : null)
    if (!idStillPresent && !pairedHost) {
      this[repoLifecycleOperationsContext].runtime.state.workspaceSession = removeLocalRepoSession(
        this[repoLifecycleOperationsContext].runtime.state.workspaceSession,
        id
      )
      this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId =
        removeRepoFromHostWorkspaceSessions(
          this[repoLifecycleOperationsContext].runtime.state.workspaceSessionsByHostId,
          id
        )
    } else if (pairedHost) {
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

  /** Sweep unregistered local repos at load; unpaired remote absence cannot prove deletion. */
  sweepDeregisteredRepoResidue(): string[] {
    const state = this[repoLifecycleOperationsContext].runtime.state
    const orphanRepoIds = collectDeregisteredRepoIds(state)
    if (orphanRepoIds.size === 0) {
      return []
    }
    for (const repoId of orphanRepoIds) {
      retireLocalWorktreeScanGeneration(repoId)
      dropRepoRestoreHints(this, repoId)
      pruneWorktreeStateForRepo(this, repoId, null)
      state.workspaceSession = removeLocalRepoSession(state.workspaceSession, repoId)
      state.workspaceSessionsByHostId = removeRepoFromHostWorkspaceSessions(
        state.workspaceSessionsByHostId,
        repoId
      )
    }
    pruneDeregisteredRepoUiResidue(state.ui, orphanRepoIds)
    return [...orphanRepoIds]
  }

  updateRepo(
    target: RepoHostTarget,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'repoIcon'
        | 'upstream'
        | 'gitRemoteIdentity'
        | 'defaultJiraProject'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'worktreeBasePath'
        | 'kind'
        | 'folderUpgradeGitRootPath'
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
      ghAccount?: GhAccountBinding | null
    }
  ): Repo | null {
    return getRepoUpdateOperations(this).updateRepo(target, updates)
  }
}

function dropRepoRestoreHints(owner: RepoLifecycleOperations, repoId: string): void {
  dropOrcadTerminalRestoreHintsForWorktrees(
    owner[repoLifecycleOperationsContext].runtime.orcadTerminalRestoreHints,
    (worktreeId) => getRepoIdFromWorktreeId(worktreeId) === repoId
  )
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
      updateRepo: (target, updates) => owner.updateRepo(target, updates),
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
