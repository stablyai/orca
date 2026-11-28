import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { RuntimeWorkspaceMetadata } from '../workspace-metadata'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  type RemoveManagedWorktreeOptions,
  type RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import { withWorktreeSpan } from '../../../observability/instrumentation'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { worktreeHostIdentity } from '../../../persistence/worktree-meta-host-identity'

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
  ): Promise<RemoveWorktreeResult & { warning?: string }> {
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
    const [mods, { removeOrphanOrFolderWorktree }, { removeRuntimeRegisteredLocalWorktree }] =
      await Promise.all([
        import('./workspace-removal-modules'),
        import('./workspace-registration-removal'),
        import('./runtime-registered-local-worktree-removal')
      ])
    // The repo row names the host; a caller may omit hostId for a worktree on another host.
    const fenceOwner = mods.resolveWorktreeRemovalRepoOwner(
      store,
      removalTarget.repoId,
      cleanupHostId
    )
    const fenceHostId =
      fenceOwner.kind === 'resolved' ? getRepoExecutionHostId(fenceOwner.repo) : cleanupHostId
    if (isWslMoveSourceHost(fenceHostId)) {
      assertWslMoveWorkspaceWritable(store, removalTarget.id)
    }
    // Why: a retry or a second client asking while Git still deletes joins that removal.
    const pending = this.joinPendingWorktreeRemoval(removalTarget.id, options)
    if (pending) {
      await mods.waitForWorktreeRemovalAcceptance(removalTarget.id, cleanupHostId)
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
    const inFlightRemoval = this.removeManagedWorktreeInFlight.get(
      cleanupScopeKey,
      removalTarget.id,
      optionsKey
    )
    if (inFlightRemoval) {
      return options.waitForBackgroundRemoval
        ? mods.finishAcceptedWorktreeRemoval(await inFlightRemoval, removalTarget.id, cleanupHostId)
        : inFlightRemoval
    }
    const removal = (async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      return withWorktreeSpan({ stage: 'remove', path: removalTarget.path }, async () => {
        const repoOwner = mods.resolveWorktreeRemovalRepoOwner(
          store,
          removalTarget.repoId,
          cleanupHostId
        )
        if (repoOwner.kind === 'ambiguous') {
          throw new Error(
            `Workspace identity is ambiguous across hosts: ${removalTarget.id}. Retry with an explicit host.`
          )
        }
        const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
        const removalHostId = repo ? (cleanupHostId ?? getRepoExecutionHostId(repo)) : cleanupHostId
        const purgeRemovedWorktree = (): Promise<void> =>
          this.purgeRemovedWorktree(store, removalTarget.id, removalTarget.repoId, removalHostId)
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
        const route = mods.resolveWorktreeRemovalRoute(removalHostId!)
        const { localWorktreeGitOptions, registeredWorktrees } =
          await mods.listWorktreesOnRemovalRoute(route, repo!, this.requireStore())
        const removedMeta = mods.resolveWorktreeRemovalMetadata(
          store,
          removalTarget.repoId,
          removalTarget.id,
          removalHostId!
        )
        const removedPushTarget = removedMeta?.pushTarget ?? removalTarget.pushTarget
        const registeredWorktree = await mods.findRegisteredWorktreeReleasingDiedAddLock(
          repo!.path,
          removalTarget.path,
          registeredWorktrees,
          mods.resolveWorktreeRemovalHome(route),
          localWorktreeGitOptions
        )
        await mods.authorizeUnregisteredWindowsRemoval(
          !!registeredWorktree,
          repo!.path,
          removalTarget.path,
          force,
          localWorktreeGitOptions
        )
        if (
          await this.retryFailedRemoval(
            route,
            removalTarget,
            registeredWorktrees,
            options,
            localWorktreeGitOptions
          )
        ) {
          return { removing: true }
        }
        if (!registeredWorktree) {
          return mods.removeRuntimeUnregisteredWorktree({
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
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = options.deleteBranch ?? removedMeta?.preserveBranchOnDelete !== true
        if (
          await mods.isStaleLocalWorktreeRegistration(
            registeredWorktree,
            force,
            removedMeta,
            localWorktreeGitOptions
          )
        ) {
          const removalResult = await mods.removeStaleLocalWorktreeRegistration({
            canonicalWorktreePath,
            repoPath: repo!.path,
            localWorktreeGitOptions,
            registeredWorktree,
            deleteBranch
          })
          await mods.cleanupUnusedWorktreePushTargetRemote(
            repo!.path,
            removalTarget.id,
            removedPushTarget,
            store,
            localWorktreeGitOptions
          )
          this.preservedBranchCleanup.remember(
            removalTarget.id,
            cleanupHostId,
            removalResult,
            registeredWorktree.head,
            removedPushTarget
          )
          await purgeRemovedWorktree()
          this.notifyWorktreesChanged(repo!.id)
          return removalResult ?? {}
        }
        return removeRuntimeRegisteredLocalWorktree({
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
          beforeCheckoutDelete: mods.archiveMarkStep(
            options,
            store,
            removalTarget.id,
            removalHostId!
          ),
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
      })
    })()
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
      return mods.finishAcceptedWorktreeRemoval(accepted, removalTarget.id, cleanupHostId)
    } finally {
      this.removeManagedWorktreeInFlight.release(cleanupScopeKey, removal)
    }
  }
}
