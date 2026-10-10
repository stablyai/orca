// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateManagedRemoteWorktree } from './orca-runtime-create-managed-remote-worktree'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../worktree-removal-repo-owner'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { finishAcceptedWorktreeRemoval } from '../worktree-background-removal'
import { preservedBranchCleanupScopeKey } from '../../shared/preserved-branch-cleanup'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  type RemoveManagedWorktreeOptions
} from './runtime-worktree-selection'
import { withWorktreeSpan } from '../observability/instrumentation'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalRoute
} from '../worktree-removal-execution-host-route'
import { listWorktreesOnRemovalRoute } from './worktree-removal-route-listing'
import { isPrunableGitFileWorktree } from '../worktree-prunable-git-file'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import { removeRuntimeUnregisteredWorktree } from './runtime-unregistered-worktree-removal'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { formatWorktreeRemovalError } from '../ipc/worktree-logic'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isRuntimeWorktreePathMissing } from './runtime-worktree-filesystem'
import { removeStaleLocalWorktreeRegistration } from '../local-worktree-removal-recovery'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import { removeOrphanOrFolderWorktree } from './orca-runtime-remove-orphan-or-folder-worktree'
import { deleteRemoteWorktreeHistory } from '../remote-worktree-history-cleanup'

export class OrcaRuntimeWithRemoveManagedWorktree extends OrcaRuntimeWithCreateManagedRemoteWorktree {
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
      allowFailedArchiveHook
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
        // One host for the whole removal. Listing on a different host from the one the prune and
        // the delete use is how an `executionHostId: 'ssh:*'`-only row got listed remotely and
        // deleted here; the route refuses rather than falling back to this machine.
        const route = resolveWorktreeRemovalRoute(removalHostId)
        const { localWorktreeGitOptions, registeredWorktrees } = await listWorktreesOnRemovalRoute(
          route,
          repo,
          this.requireStore()
        )
        const removedMeta = resolveWorktreeRemovalMetadata(
          store,
          removalTarget.repoId,
          removalTarget.id,
          removalHostId
        )
        const removedPushTarget = removedMeta?.pushTarget ?? removalTarget.pushTarget
        const removalHome = resolveWorktreeRemovalHome(route)
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo.path,
          removalTarget.path,
          registeredWorktrees,
          removalHome
        )
        if (this.retryFailedLocalRemoval(route, removalTarget, registeredWorktrees, options)) {
          return { removing: true }
        }
        if (!registeredWorktree) {
          return removeRuntimeUnregisteredWorktree({
            repo,
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
            stopPtys: (worktreeId, connectionId, allowUnverifiedPtyStop) =>
              this.stopPtysForDestructiveWorktreeRemoval(worktreeId, {
                ...(connectionId ? { connectionId } : {}),
                allowUnverifiedStop: allowUnverifiedPtyStop
              }),
            deleteHistory: () =>
              deleteRemoteWorktreeHistory(
                route.kind === 'ssh' ? this.getSshProviderFn?.(route.connectionId) : undefined,
                removalTarget.id
              ),
            finishRemoval: async () => {
              this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
              await purgeRemovedWorktree()
              this.notifyWorktreesChanged(repo.id)
            }
          })
        }
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = removedMeta?.preserveBranchOnDelete !== true
        try {
          assertWorktreeUnlockedForRemoval(registeredWorktree)
        } catch (error) {
          throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
        }
        if (
          route.kind === 'local' &&
          ((await isPrunableGitFileWorktree(registeredWorktree, localWorktreeGitOptions)) ||
            (force === true &&
              process.platform === 'win32' &&
              (isWindowsAbsolutePathLike(canonicalWorktreePath) ||
                !!localWorktreeGitOptions.wslDistro) &&
              removedMeta &&
              (await isRuntimeWorktreePathMissing(
                route.hostId,
                canonicalWorktreePath,
                localWorktreeGitOptions
              ))))
        ) {
          const removalResult = await removeStaleLocalWorktreeRegistration({
            canonicalWorktreePath,
            repoPath: repo.path,
            localWorktreeGitOptions,
            registeredWorktree,
            deleteBranch
          })
          await cleanupUnusedWorktreePushTargetRemote(
            repo.path,
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
          this.notifyWorktreesChanged(repo.id)
          return removalResult ?? {}
        }
        if (route.kind === 'ssh') {
          return removeRuntimeRegisteredRemoteWorktree({
            runHooks,
            allowFailedArchiveHook,
            repo,
            target: removalTarget,
            registeredWorktree,
            removedPushTarget,
            store,
            provider: route.provider,
            connectionId: route.connectionId,
            force,
            allowUnverifiedPtyStop,
            deleteBranch,
            acquireWatcherRemoval: this.acquireFileWatcherRemoval,
            stopPtys: () =>
              this.stopPtysForDestructiveWorktreeRemoval(removalTarget.id, {
                connectionId: route.connectionId,
                allowUnverifiedStop: allowUnverifiedPtyStop
              }),
            deleteHistory: () =>
              deleteRemoteWorktreeHistory(
                this.getSshProviderFn?.(route.connectionId),
                removalTarget.id
              ),
            preserveBranchHead: (result, fallbackHead) =>
              this.preservedBranchCleanup.preserveHead(result, fallbackHead),
            finishRemoval: async (result) => {
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                result,
                registeredWorktree.head,
                removedPushTarget
              )
              await purgeRemovedWorktree()
              this.notifyWorktreesChanged(repo.id)
            }
          })
        }
        return removeRuntimeRegisteredLocalWorktree({
          repo,
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
          publish: () => this.publishWorktreeRemovalChange(repo.id)
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
