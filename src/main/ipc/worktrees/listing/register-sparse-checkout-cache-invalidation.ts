import { clearSparseCheckoutStateCache } from '../../../git/worktree-sparse-checkout-cache'
import { registerWorktreeChangeInvalidator } from '../../worktree-change-invalidators'

export function registerSparseCheckoutCacheInvalidation(): void {
  registerWorktreeChangeInvalidator(clearSparseCheckoutStateCache)
}
