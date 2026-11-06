import type { ResolvedWorktree } from './catalog/runtime-worktree-path-identity'
import type {
  RemoveManagedWorktreeOptions,
  RuntimeWorktreeRemovalTarget
} from './catalog/runtime-worktree-selection'
import { resolveRuntimeWorktreeRemovalTarget } from './removal/runtime-worktree-removal-target'
import type { LocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import type { RuntimeStore } from '../runtime-store-contract'
import { splitWorktreeId, worktreeIdsEqual } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../workspaces/removal/worktree-removal-repo-owner'
import {
  dropRemovedWorktreeProcessState,
  pruneRemovedWorktreeSnapshots
} from '../../workspaces/removal/worktree-removal-process-cleanup'
import { forgetFailedAgentLaunches } from '../../agent-launch/agent-launch-pane-attachment'
import { closeClientHostedBrowserPagesForWorktree } from './removal/worktree-browser-client-page-close'
import { teardownStops } from './removal/owned-session-teardown-policy'
import { deleteRemovedOwnerBrowserProfile } from '../browser-host/profiles/managed-browser-profile-removal'
import type {
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../../shared/worktree/create-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { invalidateAuthorizedRootsCacheForRepo } from '../../ipc/worktrees/removal/registered-worktree-roots-scoped-invalidation'
import {
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../../workspaces/removal/worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from './removal/runtime-interrupted-local-worktree-removal'
import { retryFailedRemovalUnlessRegistered } from '../../workspaces/removal/worktree-removal-leftover'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { removeWorktreeMetaRow } from '../../persistence/host-qualified-worktree-meta'
import { RuntimeAgentLaunchPreparation } from '../terminal/launch/runtime-agent-launch-preparation'

export abstract class OrcaRuntimeWithResolveWorktreeRemovalTarget extends RuntimeAgentLaunchPreparation {
  protected abstract resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null>

  protected abstract cancelScheduledMobileSessionTabsChanged(worktreeId: string): void

  protected abstract notifyMobileSessionTabsRemoved(worktreeId: string): void

  protected async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    return resolveRuntimeWorktreeRemovalTarget({
      selector: worktreeSelector,
      store: this.store,
      resolveWorktree: (selector) => this.resolveGitWorktreeSelector(selector),
      resolveExplicitWorktreeIdScoped: (worktreeId, hostId) =>
        this.resolveExplicitWorktreeIdScoped(worktreeId, hostId),
      ...(requiredHostId ? { requiredHostId } : {})
    })
  }

  finishInterruptedWorktreeRemovals(): void {
    const store = this.store
    if (!store) {
      return
    }
    resumeInterruptedWorktreeRemovals((record) =>
      interruptedLocalWorktreeRemovalJob(record, this.localRemovalJobHost(store))
    )
  }

  protected joinPendingWorktreeRemoval(
    worktreeId: string,
    { hostId, deleteBranch }: RemoveManagedWorktreeOptions
  ): Promise<RemoveWorktreeResult> | undefined {
    return waitForPendingWorktreeRemoval(worktreeId, parseExecutionHostId(hostId)?.id, deleteBranch)
  }

  /** Failed intent schedules a retry; current Git/filesystem proof still controls every deletion. */
  protected async retryFailedRemoval(
    route: { kind: string },
    target: { id: string; path: string },
    registeredWorktrees: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions,
    localOptions: LocalProjectWorktreeGitOptions
  ): Promise<boolean> {
    const store = this.store
    if (route.kind !== 'local' || !store) {
      return false
    }
    const hostId = parseExecutionHostId(options.hostId)?.id
    const allowUnverifiedPtyStop = options.allowUnverifiedPtyStop === true
    return retryFailedRemovalUnlessRegistered(
      target.id,
      target.path,
      registeredWorktrees,
      localOptions,
      () =>
        retryFailedWorktreeRemoval(
          target.id,
          hostId,
          (record) =>
            interruptedLocalWorktreeRemovalJob(record, {
              ...this.localRemovalJobHost(store),
              stopPtys: () =>
                this.stopPtysForDestructiveWorktreeRemoval(record.worktreeId, {
                  allowUnverifiedStop: allowUnverifiedPtyStop
                })
            }),
          options.force === true,
          options.deleteBranch
        )
    )
  }

  protected localRemovalJobHost(store: RuntimeStore) {
    return {
      store,
      acquireWatcherRemoval: this.acquireFileWatcherRemoval,
      closeWatchers: (path) => this.closeFileWatchersForRemoval(path),
      preservedBranchCleanup: this.preservedBranchCleanup,
      purge: ({ worktreeId, repoId }) =>
        this.purgeRemovedWorktree(store, worktreeId, repoId, LOCAL_EXECUTION_HOST_ID),
      onRemoved: ({ worktreeId, worktreePath }) =>
        this.emitWorktreeLifecycle({ kind: 'removed', worktreeId, path: worktreePath }),
      publish: (repoId) => this.publishWorktreeRemovalChange(repoId)
    }
  }

  // Host state every removal path drops once Git has let go of the checkout.
  protected purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    removalHostId?: ExecutionHostId
  ): void {
    this.clearOptimisticReconcileToken(worktreeId)
    this.removeWorktreeMetadataAndHistory(store, worktreeId, removalHostId)
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    invalidateAuthorizedRootsCacheForRepo(store, repoId)
  }

  removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void {
    // Purge history/caches before path-derived ids can name a recreated workspace.
    const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
    const repoId = splitWorktreeId(worktreeId)?.repoId
    const preservesSameIdOwner = Boolean(
      hostId &&
      ((persistedHostId && persistedHostId !== hostId) ||
        (repoId && hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId)))
    )
    const acceptedRendererSnapshot = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
    const storedSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    removeWorktreeMetaRow(store, worktreeId, hostId)
    // Retire only this host's panes even when a same-id owner survives.
    this.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, hostId ?? persistedHostId)
    if (!preservesSameIdOwner) {
      // Do not rescue surviving paired PTYs into a recreated occupant of the same path-derived id.
      for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
        const ptyWorktreeId = this.ptysById.get(ptyId)?.worktreeId
        if (ptyWorktreeId && worktreeIdsEqual(ptyWorktreeId, worktreeId)) {
          this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
        }
      }
      const removedPublicationEpoch =
        acceptedRendererSnapshot?.publicationEpoch ??
        storedSnapshot?.publicationEpoch ??
        this.rendererGeneration ??
        undefined
      this.removedMobileSessionWorktreeIds.set(
        worktreeId,
        removedPublicationEpoch ? { removedPublicationEpoch } : {}
      )
      this.mobileSessionTabsByWorktree.delete(worktreeId)
      this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
      this.cancelScheduledMobileSessionTabsChanged(worktreeId)
      this.notifyMobileSessionTabsRemoved(worktreeId)
      dropRemovedWorktreeProcessState(worktreeId)
      this.releaseRemovedWorktreeHostSessions(worktreeId, 'worktree-removal')
    }
    const snapshotDirectory = store.getProfileStorageDirectory?.()
    if (snapshotDirectory) {
      pruneRemovedWorktreeSnapshots(snapshotDirectory, worktreeId, hostId)
    }
  }

  // All removal paths stop PTYs/chats first; release headless windows that would outlive the workspace.
  releaseRemovedWorktreeHostSessions(
    worktreeId: string,
    entryPoint: 'worktree-removal' | 'folder-removal' | 'project-removal'
  ): void {
    if (teardownStops(entryPoint, 'launch')) {
      forgetFailedAgentLaunches(worktreeId, null)
    }
    if (!teardownStops(entryPoint, 'host-browser')) {
      return
    }
    const backend = this.offscreenBrowserBackend
    for (const tab of backend ? (this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []) : []) {
      void backend?.closeTab(tab.browserPageId).catch(() => {})
    }
    closeClientHostedBrowserPagesForWorktree(this, worktreeId)
    deleteRemovedOwnerBrowserProfile({ kind: 'worktree', id: worktreeId })
  }

  async forceDeletePreservedBranch(
    worktreeSelector: string,
    branchName: string,
    expectedHead: string,
    hostId?: string
  ): Promise<ForceDeleteWorktreeBranchResult> {
    return this.preservedBranchCleanup.forceDelete(
      worktreeSelector,
      branchName,
      expectedHead,
      hostId
    )
  }
}
