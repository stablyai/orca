import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import { splitWorktreeId, worktreeIdentityKey } from '../../../../shared/worktree/id'
import type { Worktree } from '../../../../shared/worktree/types'
import { invalidateAuthorizedRootsCacheForRepo } from '../../../ipc/worktrees/removal/registered-worktree-roots-scoped-invalidation'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { assertWslMoveRepoWritable } from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { findPendingWorktreeRemovalConflict } from '../../../workspaces/removal/worktree-removal-table'
import { withProjectWorktreeCreate } from '../../../workspaces/creation/worktree-create-in-flight'
import { getExplicitWorktreeIdSelector } from '../catalog/runtime-worktree-selection'
import { createdWorktreeLifecycleIdentity } from '../lifecycle/worktree-lifecycle-event'
import { RuntimeNestedWorktreeRemoval } from '../removal/runtime-nested-worktree-removal'

export type ArchiveManagedWorktreeResult = {
  worktreeId: string
  path: string
  branch: string
  warning?: string
}

export type RestoreArchivedWorktreeResult = {
  worktree: Worktree
  warning?: string
}

export abstract class RuntimeWorkspaceArchive extends RuntimeNestedWorktreeRemoval {
  // The lifecycle queue is off in some builds; archive and restore of one workspace must never overlap.
  private readonly archiveOperations = new Set<string>()

  private async exclusiveArchiveOperation<T>(
    worktreeId: string,
    run: () => Promise<T>
  ): Promise<T> {
    const key = worktreeIdentityKey(worktreeId)
    if (this.archiveOperations.has(key)) {
      throw new Error('This workspace is already being archived or restored.')
    }
    this.archiveOperations.add(key)
    try {
      return await run()
    } finally {
      this.archiveOperations.delete(key)
    }
  }

  /** Delete the checkout through the normal removal refusals, keeping the branch and every workspace record. */
  async archiveManagedWorktree(
    worktreeSelector: string,
    options: { hostId?: string } = {}
  ): Promise<ArchiveManagedWorktreeResult> {
    const store = this.requireStore()
    const requiredHostId = parseExecutionHostId(options.hostId)?.id
    const target = await this.resolveWorktreeRemovalTarget(worktreeSelector, requiredHostId)
    return this.exclusiveArchiveOperation(target.id, async () => {
      const {
        markWorktreeCheckoutArchived,
        resolveArchivableCheckout,
        unmarkArchiveIfCheckoutRemains
      } = await import('./workspace-archive-checkout')
      const { hostId } = await resolveArchivableCheckout(store, target, requiredHostId)
      let warning: string | undefined
      try {
        ;({ warning } = await this.removeManagedWorktree(`id:${target.id}`, {
          archive: {
            markArchived: (worktree) =>
              markWorktreeCheckoutArchived(store, target.id, hostId, worktree)
          },
          runHooks: true,
          deleteBranch: false,
          waitForBackgroundRemoval: true,
          ...(options.hostId ? { hostId: options.hostId } : {})
        }))
      } catch (error) {
        await unmarkArchiveIfCheckoutRemains(store, target, hostId)
        throw error
      }
      const archived = readWorktreeMetaForHost(store, target.id, hostId)?.archivedCheckout
      if (!archived) {
        // A plain delete that started first took the workspace; nothing was kept.
        throw new Error('This workspace was deleted instead of archived.')
      }
      return {
        worktreeId: target.id,
        path: target.path,
        branch: archived.branch,
        ...(warning ? { warning } : {})
      }
    })
  }

  /** Recreate an archived workspace's checkout at its old path from its kept branch. */
  async restoreArchivedWorktree(
    worktreeSelector: string,
    options: { hostId?: string; setupDecision?: SetupDecision } = {}
  ): Promise<RestoreArchivedWorktreeResult> {
    const worktreeId = getExplicitWorktreeIdSelector(worktreeSelector) ?? worktreeSelector
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      throw new Error('selector_not_found')
    }
    return this.exclusiveArchiveOperation(worktreeId, () =>
      this.restoreArchivedCheckout(worktreeId, parsed.repoId, parsed.worktreePath, options)
    )
  }

  private async restoreArchivedCheckout(
    worktreeId: string,
    repoId: string,
    path: string,
    options: { hostId?: string; setupDecision?: SetupDecision }
  ): Promise<RestoreArchivedWorktreeResult> {
    const store = this.requireStore()
    const [
      { resolveWorktreeRemovalRepoOwner },
      { resolveWorktreeRemovalRoute },
      { recreateArchivedCheckout },
      { prepareRuntimeLocalWorktreeSetup }
    ] = await Promise.all([
      import('../../../workspaces/removal/worktree-removal-repo-owner'),
      import('../../../workspaces/removal/worktree-removal-execution-host-route'),
      import('./workspace-archive-checkout'),
      import('../creation/runtime-local-worktree-setup')
    ])
    const owner = resolveWorktreeRemovalRepoOwner(
      store,
      repoId,
      parseExecutionHostId(options.hostId)?.id
    )
    if (owner.kind !== 'resolved' || isFolderRepo(owner.repo)) {
      throw new Error('This workspace is not archived in a tracked Git project.')
    }
    const repo = owner.repo
    const hostId = getRepoExecutionHostId(repo)
    const archived = readWorktreeMetaForHost(store, worktreeId, hostId)?.archivedCheckout
    if (!archived) {
      throw new Error('This workspace is not archived.')
    }
    // The owning host restores; a client never recreates another host's checkout.
    resolveWorktreeRemovalRoute(hostId)
    assertWslMoveRepoWritable(store, repo)
    // A removal still deleting this checkout would purge the row once the mark is cleared.
    if (findPendingWorktreeRemovalConflict(repo.path, { worktreePath: path })) {
      throw new Error('This workspace is still being archived or deleted.')
    }
    // The create fence keeps the project from being removed while its checkout comes back.
    const warning = await withProjectWorktreeCreate(repo, async () => {
      const { includeCopyWarning } = await recreateArchivedCheckout(
        store,
        repo,
        worktreeId,
        path,
        archived.branch
      )
      // Fresh activity so an inactive-workspace rule doesn't archive it again right away.
      store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId }), {
        isArchived: false,
        archivedCheckout: undefined,
        lastActivityAt: Date.now()
      })
      // Archive ran the teardown hook, so setup runs on every restore; no terminal here, so in-process.
      const setup = await prepareRuntimeLocalWorktreeSetup({
        request: options.setupDecision ? { setupDecision: options.setupDecision } : {},
        repo,
        worktreePath: path,
        settings: store.getSettings(),
        runtimeTarget: this.getLocalGitExecutionOptionArgs(repo)[0],
        shouldUseSetupRunner: false,
        warning: includeCopyWarning
      })
      return setup.warning
    })
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    invalidateAuthorizedRootsCacheForRepo(store, repo)
    this.notifyWorktreesChanged(repo.id)
    const worktree = await this.showManagedWorktree(`id:${worktreeId}`, hostId)
    this.emitWorktreeLifecycle({
      kind: 'created',
      worktreeId,
      path: worktree.path,
      branch: worktree.branch,
      ...createdWorktreeLifecycleIdentity(worktree)
    })
    return { worktree, ...(warning ? { warning } : {}) }
  }
}
