import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import {
  adoptRuntimeProvisionedRoot,
  readLocalSparseCheckoutEnabled,
  type RuntimeProvisionedRootRequest
} from './runtime-provisioned-root-adoption'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { OrcaRuntimeWithCreateManagedWorktree } from './workspace-creation'

export abstract class RuntimeProvisionedWorkspaceAdoption extends OrcaRuntimeWithCreateManagedWorktree {
  adoptManagedProvisionedRoot(
    repoSelector: string,
    request: RuntimeProvisionedRootRequest
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return adoptRuntimeProvisionedRoot(repoSelector, request, {
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
  }
}
