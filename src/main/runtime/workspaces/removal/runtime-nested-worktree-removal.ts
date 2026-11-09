import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { NestedWorktreeRemovalApproval } from '../../../../shared/worktree/nested-removal'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { resolveWorktreeRemovalRepoOwner } from '../../../workspaces/removal/worktree-removal-repo-owner'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalRoute
} from '../../../workspaces/removal/worktree-removal-execution-host-route'
import {
  assertNestedWorktreeRemovalApproval,
  getNestedWorktreeRemovalPlan,
  removeNestedWorktreePlanChildren,
  withNestedPreservedBranches
} from '../../../workspaces/removal/nested-worktree-removal-plan'
import type {
  RemoveManagedWorktreeOptions,
  RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import { OrcaRuntimeWithRemoveManagedWorktree } from './workspace-removal'
import { listWorktreesOnRemovalRoute } from './worktree-removal-route-listing'

/** Lists what deleting the target would take with it: nested worktrees deepest-first, then the target. */
async function previewRuntimeNestedWorktreeRemoval(
  store: RuntimeStore,
  target: RuntimeWorktreeRemovalTarget,
  hostId: ExecutionHostId | undefined
): Promise<GitWorktreeInfo[]> {
  const owner = resolveWorktreeRemovalRepoOwner(store, target.repoId, hostId)
  if (owner.kind === 'ambiguous') {
    throw new Error(
      `Workspace identity is ambiguous across hosts: ${target.id}. Retry with an explicit host.`
    )
  }
  if (owner.kind === 'missing') {
    throw new Error(`Repo not found: ${target.repoId}`)
  }
  if (isFolderRepo(owner.repo)) {
    throw new Error('Nested worktree deletion is only available for Git workspaces.')
  }
  const route = resolveWorktreeRemovalRoute(hostId ?? getRepoExecutionHostId(owner.repo))
  const { registeredWorktrees } = await listWorktreesOnRemovalRoute(route, owner.repo, store)
  return getNestedWorktreeRemovalPlan({
    repoPath: owner.repo.path,
    worktreePath: target.path,
    worktrees: registeredWorktrees,
    home: resolveWorktreeRemovalHome(route)
  })
}

/** Re-checks the reviewed plan, deletes nested children, then the target itself. */
async function removeRuntimeApprovedNestedWorktrees(args: {
  store: RuntimeStore
  target: RuntimeWorktreeRemovalTarget
  hostId: ExecutionHostId | undefined
  approved: readonly NestedWorktreeRemovalApproval[]
  force: boolean
  removeChild: (worktreeId: string) => Promise<RemoveWorktreeResult>
  removeTarget: () => Promise<RemoveWorktreeResult & { warning?: string }>
}): Promise<RemoveWorktreeResult & { warning?: string }> {
  if (!args.force) {
    throw new Error('Deleting nested worktrees requires an explicit confirmation.')
  }
  const plan = await previewRuntimeNestedWorktreeRemoval(args.store, args.target, args.hostId)
  assertNestedWorktreeRemovalApproval(plan, args.approved)
  const preserved = await removeNestedWorktreePlanChildren(args.target.repoId, plan, (id) =>
    args.removeChild(id)
  )
  try {
    const result = await args.removeTarget()
    return preserved.length > 0 ? { ...result, nestedPreservedBranches: preserved } : result
  } catch (error) {
    throw withNestedPreservedBranches(error, preserved)
  }
}

export abstract class RuntimeNestedWorktreeRemoval extends OrcaRuntimeWithRemoveManagedWorktree {
  async previewNestedManagedWorktreeRemoval(
    worktreeSelector: string,
    hostId?: string
  ): Promise<GitWorktreeInfo[]> {
    const cleanupHostId = parseExecutionHostId(hostId)?.id
    const target = await this.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
    return previewRuntimeNestedWorktreeRemoval(this.requireStore(), target, cleanupHostId)
  }

  async removeManagedWorktreeWithNested(
    worktreeSelector: string,
    approved: readonly NestedWorktreeRemovalApproval[],
    options: RemoveManagedWorktreeOptions = {}
  ): Promise<RemoveWorktreeResult & { warning?: string }> {
    const cleanupHostId = parseExecutionHostId(options.hostId)?.id
    const target = await this.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
    return removeRuntimeApprovedNestedWorktrees({
      store: this.requireStore(),
      target,
      hostId: cleanupHostId,
      approved,
      force: options.force === true,
      // The parent's nested-worktree guard re-lists, so each child must be gone before the next step.
      removeChild: (worktreeId) =>
        this.removeManagedWorktree(`id:${worktreeId}`, {
          ...options,
          waitForBackgroundRemoval: true
        }),
      removeTarget: () => this.removeManagedWorktree(worktreeSelector, options)
    })
  }
}
