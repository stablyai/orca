import { removeRuntimeStaleWorktreeRegistration } from './runtime-stale-worktree-registration-removal'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { RuntimeWorkspaceMetadata } from '../workspace-metadata'
import {
  resolveWorktreeRemovalRepoOwner,
  resolveUnambiguousWorktreeRemovalRepo
} from '../../../workspaces/removal/worktree-removal-repo-owner'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  finishAcceptedWorktreeRemoval,
  waitForWorktreeRemovalAcceptance
} from '../../../workspaces/removal/worktree-background-removal'
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  type RemoveManagedWorktreeOptions,
  type RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import { withWorktreeSpan } from '../../../observability/instrumentation'
import { resolveWorktreeRemovalRoute } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import { selectWorktreeOnRemovalRoute } from './worktree-removal-route-listing'
import { removeRuntimeUnregisteredWorktree } from './runtime-unregistered-worktree-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import { removeOrphanOrFolderWorktree } from './workspace-registration-removal'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { worktreeHostIdentity } from '../../../persistence/worktree-meta-host-identity'
import { archiveMarkStep } from '../archive/workspace-archive-checkout'
import { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'

type RuntimeRemovalResult = RemoveWorktreeResult & { warning?: string }

export abstract class OrcaRuntimeWithRemoveManagedWorktree extends RuntimeWorkspaceMetadata {
  abstract removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): Promise<void>
  protected abstract resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget>
  protected abstract joinPendingWorktreeRemoval(
    worktreeId: string,
    options: RemoveManagedWorktreeOptions
  ): Promise<RemoveWorktreeResult> | undefined
  protected abstract purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    removalHostId?: ExecutionHostId
  ): Promise<void>
  protected abstract retryFailedRemoval(
    route: { kind: string },
    target: { id: string; path: string },
    registeredWorktrees: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions,
    localOptions: LocalProjectWorktreeGitOptions
  ): Promise<boolean>

  async removeManagedWorktree(
    worktreeSelector: string,
    options: RemoveManagedWorktreeOptions = {}
  ): Promise<RuntimeRemovalResult> {
    const expectation = options.expectedWorktree
      ? new WorktreeRemovalExpectation(
          this.requireStore(),
          options.expectedWorktree,
          parseExecutionHostId(options.hostId)?.id
        )
      : undefined
    return expectation
      ? expectation.run(() => this.removeExpectedWorktree(worktreeSelector, options, expectation))
      : this.removeExpectedWorktree(worktreeSelector, options)
  }

  private async removeExpectedWorktree(
    worktreeSelector: string,
    options: RemoveManagedWorktreeOptions,
    expectation?: WorktreeRemovalExpectation
  ): Promise<RuntimeRemovalResult> {
    const {
      force = false,
      runHooks = false,
      allowUnverifiedPtyStop = false,
      allowFailedArchiveHook = false,
      hostId
    } = options
    const store = this.requireStore()
    const cleanupHostId = parseExecutionHostId(hostId)?.id
    const removalTarget = await this.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
    expectation?.check(removalTarget.id)
    // The repo row names the host; a caller may omit hostId for a worktree on another host.
    const fenceOwner = resolveWorktreeRemovalRepoOwner(store, removalTarget.repoId, cleanupHostId)
    const fenceHostId =
      fenceOwner.kind === 'resolved' ? getRepoExecutionHostId(fenceOwner.repo) : cleanupHostId
    if (isWslMoveSourceHost(fenceHostId)) {
      assertWslMoveWorkspaceWritable(store, removalTarget.id)
    }
    // Why: a retry or a second client asking while Git still deletes joins that removal.
    const pending = this.joinPendingWorktreeRemoval(removalTarget.id, options)
    if (pending) {
      expectation?.joined()
      await waitForWorktreeRemovalAcceptance(removalTarget.id, cleanupHostId)
      return options.waitForBackgroundRemoval ? await pending : { removing: true }
    }
    // Identity read now: the purge drops the row before listeners hear `removed`.
    const removed = {
      kind: 'removed' as const,
      worktreeId: removalTarget.id,
      path: removalTarget.path,
      ...worktreeHostIdentity(store, removalTarget.id, fenceHostId)
    }
    const emitRemoved = (): void => this.emitWorktreeLifecycle(removed)
    const cleanupScopeKey = preservedBranchCleanupScopeKey({
      worktreeId: removalTarget.id,
      hostId: cleanupHostId
    })
    const optionsKey = getRuntimeWorktreeRemovalOptionsKey(options)
    if (this.removeManagedWorktreeInFlight.has(cleanupScopeKey)) {
      expectation?.joined()
    }
    const inFlightRemoval = this.removeManagedWorktreeInFlight.get(
      cleanupScopeKey,
      removalTarget.id,
      optionsKey,
      !!expectation
    )
    if (inFlightRemoval) {
      return options.waitForBackgroundRemoval
        ? finishAcceptedWorktreeRemoval(await inFlightRemoval, removalTarget.id, cleanupHostId)
        : inFlightRemoval
    }
    const removal = withWorktreeSpan<RuntimeRemovalResult>(
      { stage: 'remove', path: removalTarget.path },
      async () => {
        const { repo, hostId: removalHostId } = resolveUnambiguousWorktreeRemovalRepo(
          store,
          removalTarget,
          cleanupHostId,
          !!expectation
        )
        const purgeRemovedWorktree = (): Promise<void> => {
          expectation?.check()
          return this.purgeRemovedWorktree(
            store,
            removalTarget.id,
            removalTarget.repoId,
            removalHostId
          )
        }
        const orphanOrFolderResult = await removeOrphanOrFolderWorktree({
          runtime: this,
          store,
          removalTarget,
          cleanupHostId,
          removalHostId,
          repo,
          archive: { runHooks, allowFailedArchiveHook }
        })
        if (orphanOrFolderResult) {
          return orphanOrFolderResult
        }
        // Use one host for list/prune/delete; executionHostId-only SSH rows must never fall back to this client. Missing/folder repos returned earlier.
        const route = resolveWorktreeRemovalRoute(removalHostId!)
        const {
          localWorktreeGitOptions,
          registeredWorktrees,
          removedMeta,
          removedPushTarget,
          registeredWorktree
        } = await selectWorktreeOnRemovalRoute({
          route,
          repo: repo!,
          store,
          target: removalTarget,
          hostId: removalHostId!,
          force,
          expectation
        })
        if (
          !expectation &&
          (await this.retryFailedRemoval(
            route,
            removalTarget,
            registeredWorktrees,
            options,
            localWorktreeGitOptions
          ))
        ) {
          return { removing: true }
        }
        if (!registeredWorktree) {
          return removeRuntimeUnregisteredWorktree({
            repo: repo!,
            target: removalTarget,
            registeredWorktrees,
            removedMeta,
            removedPushTarget,
            force,
            allowUnverifiedPtyStop,
            route,
            localOptions: localWorktreeGitOptions,
            store,
            acquireWatcherRemoval: this.acquireFileWatcherRemoval,
            stopPtys: (worktreeId, allowUnverifiedPtyStop) =>
              this.stopPtysForDestructiveWorktreeRemoval(worktreeId, {
                allowUnverifiedStop: allowUnverifiedPtyStop
              }),
            finishRemoval: async () => {
              this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
              await purgeRemovedWorktree()
              this.notifyWorktreesChanged(repo!.id)
            }
          })
        }
        const deleteBranch = options.deleteBranch ?? removedMeta?.preserveBranchOnDelete !== true
        const staleResult = await removeRuntimeStaleWorktreeRegistration({
          repo: repo!,
          registeredWorktree,
          removedMeta,
          removedPushTarget,
          worktreeId: removalTarget.id,
          force,
          deleteBranch,
          localWorktreeGitOptions,
          store,
          cleanupHostId,
          expectation,
          preservedBranchCleanup: this.preservedBranchCleanup,
          purge: purgeRemovedWorktree,
          publish: () => this.notifyWorktreesChanged(repo!.id)
        })
        if (staleResult) {
          return staleResult
        }
        return removeRuntimeRegisteredLocalWorktree({
          expectation,
          repo: repo!,
          target: removalTarget,
          registeredWorktree,
          removedPushTarget,
          store,
          localOptions: localWorktreeGitOptions,
          hasLocalOptions: Object.keys(localWorktreeGitOptions).length > 0,
          force,
          runHooks,
          allowFailedArchiveHook,
          allowUnverifiedPtyStop,
          deleteBranch,
          requestedDeleteBranch: options.deleteBranch,
          acquireWatcherRemoval: this.acquireFileWatcherRemoval,
          stopPtys: () =>
            this.stopPtysForDestructiveWorktreeRemoval(removalTarget.id, {
              allowUnverifiedStop: allowUnverifiedPtyStop
            }),
          beforeCheckoutDelete: archiveMarkStep(options, store, removalTarget.id, removalHostId!),
          closeWatchers: (path) => this.closeFileWatchersForRemoval(path),
          preserveBranchHead: (result, fallbackHead) =>
            this.preservedBranchCleanup.preserveHead(result, fallbackHead),
          finishRemoval: async (result, rememberBranch, fallbackHead) => {
            if (rememberBranch) {
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                result,
                fallbackHead,
                removedPushTarget
              )
            } else {
              this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
            }
            await purgeRemovedWorktree()
          },
          onRemoved: emitRemoved,
          publish: () => this.publishWorktreeRemovalChange(repo!.id)
        })
      }
    )
    this.removeManagedWorktreeInFlight.track(cleanupScopeKey, optionsKey, removal)
    try {
      const accepted = await removal
      // A background removal emits this when Git finishes instead.
      if (!accepted.removing) {
        emitRemoved()
      }
      if (!options.waitForBackgroundRemoval) {
        return accepted
      }
      // oxlint-disable-next-line typescript/return-await -- the in-flight entry covers acceptance only, not the background wait
      return finishAcceptedWorktreeRemoval(accepted, removalTarget.id, cleanupHostId)
    } finally {
      this.removeManagedWorktreeInFlight.release(cleanupScopeKey, removal)
    }
  }
}
