import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import type { Worktree } from '../../../../shared/worktree/types'
import { invalidateAuthorizedRootsCacheForRepo } from '../../../ipc/worktrees/removal/registered-worktree-roots-scoped-invalidation'
import {
  hostWorktreeTarget,
  readWorktreeMetaForHost
} from '../../../persistence/host-qualified-worktree-meta'
import { assertWslMoveRepoWritable } from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { resolveWorktreeRemovalRoute } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import { resolveWorktreeRemovalRepoOwner } from '../../../workspaces/removal/worktree-removal-repo-owner'
import { getExplicitWorktreeIdSelector } from '../catalog/runtime-worktree-selection'
import { prepareRuntimeLocalWorktreeSetup } from '../creation/runtime-local-worktree-setup'
import { createdWorktreeLifecycleIdentity } from '../lifecycle/worktree-lifecycle-event'
import { RuntimeNestedWorktreeRemoval } from '../removal/runtime-nested-worktree-removal'
import {
  markWorktreeCheckoutArchived,
  recreateArchivedCheckout,
  resolveArchivableCheckout,
  unmarkArchiveIfCheckoutRemains
} from './workspace-archive-checkout'

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
  /** Delete the checkout through the normal removal refusals, keeping the branch and every workspace record. */
  async archiveManagedWorktree(
    worktreeSelector: string,
    options: { hostId?: string } = {}
  ): Promise<ArchiveManagedWorktreeResult> {
    const store = this.requireStore()
    const requiredHostId = parseExecutionHostId(options.hostId)?.id
    const target = await this.resolveWorktreeRemovalTarget(worktreeSelector, requiredHostId)
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
    return {
      worktreeId: target.id,
      path: target.path,
      branch: readWorktreeMetaForHost(store, target.id, hostId)?.archivedCheckout?.branch ?? '',
      ...(warning ? { warning } : {})
    }
  }

  /** Recreate an archived workspace's checkout at its old path from its kept branch. */
  async restoreArchivedWorktree(
    worktreeSelector: string,
    options: { hostId?: string; setupDecision?: SetupDecision } = {}
  ): Promise<RestoreArchivedWorktreeResult> {
    const store = this.requireStore()
    const worktreeId = getExplicitWorktreeIdSelector(worktreeSelector) ?? worktreeSelector
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      throw new Error('selector_not_found')
    }
    const owner = resolveWorktreeRemovalRepoOwner(
      store,
      parsed.repoId,
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
    const path = parsed.worktreePath
    const recreated = await recreateArchivedCheckout(store, repo, worktreeId, path, archived.branch)
    let warning = recreated?.includeCopyWarning
    // Fresh activity so an inactive-workspace rule doesn't archive it again right away.
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId }), {
      isArchived: false,
      archivedCheckout: undefined,
      lastActivityAt: Date.now()
    })
    if (recreated) {
      const setup = await prepareRuntimeLocalWorktreeSetup({
        request: options.setupDecision ? { setupDecision: options.setupDecision } : {},
        repo,
        worktreePath: path,
        settings: store.getSettings(),
        runtimeTarget: this.getLocalGitExecutionOptionArgs(repo)[0],
        // Restore has no terminal to show setup in, so the hook runs in this process.
        shouldUseSetupRunner: false,
        warning
      })
      warning = setup.warning
    }
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
