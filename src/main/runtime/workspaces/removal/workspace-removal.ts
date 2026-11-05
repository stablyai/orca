import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { OrcaRuntimeWithCreateManagedRemoteWorktree } from '../workspace-metadata'
import { removeRuntimeStaleLocalWorktreeRegistration } from './runtime-stale-local-worktree-removal'
import { captureWorktreeOwnerRemoval } from './canonical-owner-removal-scopes'
import type { CapturedOwnerRemoval } from './canonical-owner-removal'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../../../workspaces/removal/worktree-removal-repo-owner'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { finishAcceptedWorktreeRemoval } from '../../../workspaces/removal/worktree-background-removal'
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  type RemoveManagedWorktreeOptions,
  type RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import { withWorktreeSpan } from '../../../observability/instrumentation'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalRoute
} from '../../../workspaces/removal/worktree-removal-execution-host-route'
import { listWorktreesOnRemovalRoute } from './worktree-removal-route-listing'
import { authorizeUnregisteredWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import { removeRuntimeUnregisteredWorktree } from './runtime-unregistered-worktree-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import { removeOrphanOrFolderWorktree } from './workspace-registration-removal'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'

export abstract class OrcaRuntimeWithRemoveManagedWorktree extends OrcaRuntimeWithCreateManagedRemoteWorktree {
  abstract removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void
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
  ): void
  protected abstract retryFailedRemoval(
    route: { kind: string },
    target: { id: string; path: string },
    registeredWorktrees: readonly GitWorktreeInfo[],
    options: RemoveManagedWorktreeOptions,
    localOptions: LocalProjectWorktreeGitOptions,
    removeOwned?: CapturedOwnerRemoval
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
    const optionsKey = getRuntimeWorktreeRemovalOptionsKey(options)
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
    const removal = withWorktreeSpan(
      { stage: 'remove', path: removalTarget.path },
      async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
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
        const removeOwned = captureWorktreeOwnerRemoval(
          store,
          removalTarget.id,
          removalHostId,
          () => this.openAgentSessionRecordStore()
        )
        const purgeRemovedWorktree = (bookkeeping: () => void = () => {}) =>
          removeOwned(() => {
            bookkeeping()
            this.purgeRemovedWorktree(store, removalTarget.id, removalTarget.repoId, removalHostId)
          })
        const orphanOrFolderResult = await removeOrphanOrFolderWorktree({
          runtime: this,
          store,
          removalTarget,
          cleanupHostId,
          removalHostId,
          repo,
          removeOwned
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
            localWorktreeGitOptions,
            removeOwned
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
                allowUnverifiedStop: allowUnverifiedPtyStop,
                deferSurfaceRetirement: true
              }),
            finishRemoval: async () => {
              await purgeRemovedWorktree(() =>
                this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
              )
              this.notifyWorktreesChanged(repo!.id)
            }
          })
        }
        const deleteBranch = options.deleteBranch ?? removedMeta?.preserveBranchOnDelete !== true
        const staleRemoval = await removeRuntimeStaleLocalWorktreeRegistration({
          registeredWorktree,
          force,
          removedMeta,
          localOptions: localWorktreeGitOptions,
          repo: repo!,
          target: removalTarget,
          deleteBranch,
          removedPushTarget,
          store,
          finishRemoval: async (result) => {
            await purgeRemovedWorktree(() =>
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                result,
                registeredWorktree.head,
                removedPushTarget
              )
            )
            this.notifyWorktreesChanged(repo!.id)
          }
        })
        if (staleRemoval) {
          return staleRemoval
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
              allowUnverifiedStop: allowUnverifiedPtyStop,
              deferSurfaceRetirement: true
            }),
          closeWatchers: (path) => this.closeFileWatchersForRemoval(path),
          preserveBranchHead: (result, fallbackHead) =>
            this.preservedBranchCleanup.preserveHead(result, fallbackHead),
          finishRemoval: (result, rememberBranch, fallbackHead) =>
            purgeRemovedWorktree(() => {
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                rememberBranch ? result : undefined,
                fallbackHead,
                removedPushTarget
              )
            }),
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
      return options.waitForBackgroundRemoval
        ? finishAcceptedWorktreeRemoval(accepted, removalTarget.id, cleanupHostId)
        : accepted
    } finally {
      this.removeManagedWorktreeInFlight.release(cleanupScopeKey, removal)
    }
  }
}
