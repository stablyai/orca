import type { LocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { isStaleLocalWorktreeRegistration } from './stale-worktree-registration-preflight'
import type { RuntimeStore } from '../runtime-store-contract'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { OrcaRuntimeWithCreateManagedRemoteWorktree } from './workspace-metadata'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../../worktree-removal-repo-owner'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { finishAcceptedWorktreeRemoval } from '../../worktree-background-removal'
import { preservedBranchCleanupScopeKey } from '../../../shared/preserved-branch-cleanup'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  type RemoveManagedWorktreeOptions,
  type RuntimeWorktreeRemovalTarget
} from '../runtime-worktree-selection'
import { withWorktreeSpan } from '../../observability/instrumentation'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalRoute
} from '../../worktree-removal-execution-host-route'
import { listWorktreesOnRemovalRoute } from '../worktree-removal-route-listing'
import { authorizeUnregisteredWindowsRemoval } from '../../git/windows-worktree-removal'
import { findRegisteredDeletableWorktree } from '../../worktree-removal-safety'
import { removeRuntimeUnregisteredWorktree } from '../runtime-unregistered-worktree-removal'
import { removeStaleLocalWorktreeRegistration } from '../../local-worktree-removal-recovery'
import { cleanupUnusedWorktreePushTargetRemote } from '../../ipc/worktree-remote'
import { removeRuntimeRegisteredLocalWorktree } from '../runtime-registered-local-worktree-removal'
import { removeOrphanOrFolderWorktree } from './workspace-registration-removal'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

export abstract class OrcaRuntimeWithRemoveManagedWorktree extends OrcaRuntimeWithCreateManagedRemoteWorktree {
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
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.store
    const cleanupHostId = parseExecutionHostId(hostId)?.id
    const removalTarget = await this.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
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
      return options.waitForBackgroundRemoval ? await pending : { removing: true }
    }
    const emitRemoved = (): void =>
      this.emitWorktreeLifecycle({
        kind: 'removed',
        worktreeId: removalTarget.id,
        path: removalTarget.path
      })
    const cleanupScopeKey = preservedBranchCleanupScopeKey({
      worktreeId: removalTarget.id,
      hostId: cleanupHostId
    })
    const optionsKey = getRuntimeWorktreeRemovalOptionsKey({
      force,
      runHooks,
      allowUnverifiedPtyStop,
      allowFailedArchiveHook,
      deleteBranch: options.deleteBranch
    })
    const inFlightRemoval = this.removeManagedWorktreeInFlight.get(
      cleanupScopeKey,
      removalTarget.id,
      optionsKey
    )
    if (inFlightRemoval) {
      return options.waitForBackgroundRemoval
        ? finishAcceptedWorktreeRemoval(await inFlightRemoval, removalTarget.id, cleanupHostId)
        : inFlightRemoval
    }
    const removal = (async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      return withWorktreeSpan({ stage: 'remove', path: removalTarget.path }, async () => {
        const repoOwner = resolveWorktreeRemovalRepoOwner(
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
          repo
        })
        if (orphanOrFolderResult) {
          return orphanOrFolderResult
        }
        // Use one host for list/prune/delete; executionHostId-only SSH rows must never fall back to this client. Missing/folder repos returned earlier.
        const route = resolveWorktreeRemovalRoute(removalHostId!)
        const { localWorktreeGitOptions, registeredWorktrees } = await listWorktreesOnRemovalRoute(
          route,
          repo!,
          this.requireStore()
        )
        const removedMeta = resolveWorktreeRemovalMetadata(
          store,
          removalTarget.repoId,
          removalTarget.id,
          removalHostId!
        )
        const removedPushTarget = removedMeta?.pushTarget ?? removalTarget.pushTarget
        const removalHome = resolveWorktreeRemovalHome(route)
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo!.path,
          removalTarget.path,
          registeredWorktrees,
          removalHome
        )
        await authorizeUnregisteredWindowsRemoval(
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
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = options.deleteBranch ?? removedMeta?.preserveBranchOnDelete !== true
        if (
          await isStaleLocalWorktreeRegistration(
            registeredWorktree,
            force,
            removedMeta,
            localWorktreeGitOptions
          )
        ) {
          const removalResult = await removeStaleLocalWorktreeRegistration({
            canonicalWorktreePath,
            repoPath: repo!.path,
            localWorktreeGitOptions,
            registeredWorktree,
            deleteBranch
          })
          await cleanupUnusedWorktreePushTargetRemote(
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
      return options.waitForBackgroundRemoval
        ? finishAcceptedWorktreeRemoval(accepted, removalTarget.id, cleanupHostId)
        : accepted
    } finally {
      this.removeManagedWorktreeInFlight.release(cleanupScopeKey, removal)
    }
  }
}
