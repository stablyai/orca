import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import {
  adoptRuntimeProvisionedRoot,
  readLocalSparseCheckoutEnabled,
  type RuntimeProvisionedRootRequest
} from './runtime-provisioned-root-adoption'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { OrcaRuntimeWithCreateManagedWorktree } from './workspace-creation'

export abstract class RuntimeProvisionedWorkspaceAdoption extends OrcaRuntimeWithCreateManagedWorktree {
  async adoptManagedProvisionedRoot(
    repoSelector: string,
    request: RuntimeProvisionedRootRequest
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    // Parent and note-task inference resolve before adoption, as a create resolves them before checkout.
    const lineageResolution =
      request.parentWorkspace || request.crossStoreParent || request.comment
        ? await this.resolveLineageForWorktreeCreate(
            {
              parentWorkspace: request.parentWorkspace,
              // App-picked parents are manual; older clients send no origin for parentWorkspace.
              ...(request.parentWorkspace || request.parentWorkspaceOrigin
                ? { parentWorkspaceOrigin: 'manual' as const }
                : {}),
              crossStoreParent: request.crossStoreParent,
              crossStoreParentInferredFrom: request.crossStoreParentInferredFrom,
              comment: request.comment
            },
            await this.resolveRepoSelector(repoSelector)
          )
        : undefined
    const adopted = await adoptRuntimeProvisionedRoot(repoSelector, request, {
      store: this.store,
      resolveRepo: (selector) => this.resolveRepoSelector(selector),
      listWorktrees: (repoPath) => listWorktreesStrict(repoPath),
      isSparseCheckoutEnabled: readLocalSparseCheckoutEnabled,
      invalidateScan: (repoId) => {
        this.invalidateResolvedWorktreeCache()
        this.invalidateWorktreeScanCacheForRepo(repoId)
      },
      notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
      showWorktree: (selector) => this.showManagedWorktree(selector)
    })
    if (!lineageResolution) {
      return adopted
    }
    const { warnings, ...recorded } = this.recordCreatedWorktreeLineage(
      adopted.worktree,
      lineageResolution
    )
    return { ...adopted, ...recorded, ...(warnings.length > 0 ? { warnings } : {}) }
  }
}
