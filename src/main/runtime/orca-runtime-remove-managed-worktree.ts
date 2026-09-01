// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateManagedRemoteWorktree } from './orca-runtime-create-managed-remote-worktree'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../worktree-removal-repo-owner'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { preservedBranchCleanupScopeKey } from '../../shared/preserved-branch-cleanup'
import { getRuntimeWorktreeRemovalOptionsKey } from './runtime-worktree-selection'
import { withWorktreeSpan } from '../observability/instrumentation'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { listWorktreesStrict } from '../git/worktree'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import { removeRuntimeUnregisteredWorktree } from './runtime-unregistered-worktree-removal'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { formatWorktreeRemovalError } from '../ipc/worktree-logic'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isRuntimeWorktreePathMissing } from './runtime-worktree-filesystem'
import { removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval } from '../local-worktree-removal-recovery'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import { removeOrphanOrFolderWorktree } from './orca-runtime-remove-orphan-or-folder-worktree'
import { deleteRemoteWorktreeHistory } from '../remote-worktree-history-cleanup'

export class OrcaRuntimeWithRemoveManagedWorktree extends OrcaRuntimeWithCreateManagedRemoteWorktree {
  async removeManagedWorktree(
    worktreeSelector: string,
    force = false,
    runHooks = false,
    allowUnverifiedPtyStop = false,
    hostId?: string
  ): Promise<RemoveWorktreeResult & { warning?: string }> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.store
    const cleanupHostId = parseExecutionHostId(hostId)?.id
    const removalTarget = await this.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
    const cleanupScopeKey = preservedBranchCleanupScopeKey({
      worktreeId: removalTarget.id,
      hostId: cleanupHostId
    })
    const optionsKey = getRuntimeWorktreeRemovalOptionsKey(force, runHooks, allowUnverifiedPtyStop)
    const inFlightRemoval = this.removeManagedWorktreeInFlight.get(
      cleanupScopeKey,
      removalTarget.id,
      optionsKey
    )
    if (inFlightRemoval) {
      return inFlightRemoval
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
        const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
        const fsProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : null
        const localWorktreeGitOptions = repo.connectionId
          ? {}
          : getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
        const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
        const registeredWorktrees = repo.connectionId
          ? await provider!.listWorktrees(repo.path)
          : hasLocalWorktreeGitOptions
            ? await listWorktreesStrict(repo.path, localWorktreeGitOptions)
            : await listWorktreesStrict(repo.path)
        const removedMeta = resolveWorktreeRemovalMetadata(
          store,
          removalTarget.repoId,
          removalTarget.id,
          cleanupHostId ?? getRepoExecutionHostId(repo)
        )
        const removedPushTarget = removedMeta?.pushTarget ?? removalTarget.pushTarget
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo.path,
          removalTarget.path,
          registeredWorktrees
        )
        if (!registeredWorktree) {
          return removeRuntimeUnregisteredWorktree({
            repo,
            target: removalTarget,
            registeredWorktrees,
            removedMeta,
            removedPushTarget,
            force,
            allowUnverifiedPtyStop,
            provider,
            fsProvider: fsProvider ?? null,
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
                repo.connectionId ? this.getSshProviderFn?.(repo.connectionId) : undefined,
                removalTarget.id
              ),
            finishRemoval: () => {
              this.clearOptimisticReconcileToken(removalTarget.id)
              this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
              this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
              this.invalidateResolvedWorktreeCache()
              this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
              invalidateAuthorizedRootsCache()
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
          !repo.connectionId &&
          force === true &&
          process.platform === 'win32' &&
          (isWindowsAbsolutePathLike(canonicalWorktreePath) ||
            !!localWorktreeGitOptions.wslDistro) &&
          removedMeta &&
          (await isRuntimeWorktreePathMissing(repo, canonicalWorktreePath, localWorktreeGitOptions))
        ) {
          const removalResult = await removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
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
          this.clearOptimisticReconcileToken(removalTarget.id)
          this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
          this.invalidateResolvedWorktreeCache()
          this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
          invalidateAuthorizedRootsCache()
          this.notifyWorktreesChanged(repo.id)
          return removalResult ?? {}
        }
        if (repo.connectionId) {
          return removeRuntimeRegisteredRemoteWorktree({
            repo,
            target: removalTarget,
            registeredWorktree,
            removedPushTarget,
            store,
            provider: provider!,
            force,
            allowUnverifiedPtyStop,
            deleteBranch,
            acquireWatcherRemoval: this.acquireFileWatcherRemoval,
            stopPtys: () =>
              this.stopPtysForDestructiveWorktreeRemoval(removalTarget.id, {
                connectionId: repo.connectionId!,
                allowUnverifiedStop: allowUnverifiedPtyStop
              }),
            deleteHistory: () =>
              deleteRemoteWorktreeHistory(
                this.getSshProviderFn?.(repo.connectionId!),
                removalTarget.id
              ),
            preserveBranchHead: (result, fallbackHead) =>
              this.preservedBranchCleanup.preserveHead(result, fallbackHead),
            finishRemoval: (result) => {
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                result,
                registeredWorktree.head,
                removedPushTarget
              )
              this.clearOptimisticReconcileToken(removalTarget.id)
              this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
              this.invalidateResolvedWorktreeCache()
              this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
              invalidateAuthorizedRootsCache()
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
          hasLocalOptions: hasLocalWorktreeGitOptions,
          force,
          runHooks,
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
          finishRemoval: (result, rememberBranch, fallbackHead) => {
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
            this.clearOptimisticReconcileToken(removalTarget.id)
            this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
            this.invalidateResolvedWorktreeCache()
            this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
            invalidateAuthorizedRootsCache()
            this.notifyWorktreesChanged(repo.id)
          }
        })
      })
    })()
    this.removeManagedWorktreeInFlight.track(cleanupScopeKey, optionsKey, removal)
    try {
      const result = await removal
      this.emitWorktreeLifecycle({
        kind: 'removed',
        worktreeId: removalTarget.id,
        path: removalTarget.path
      })
      return result
    } finally {
      this.removeManagedWorktreeInFlight.release(cleanupScopeKey, removal)
    }
  }
}
