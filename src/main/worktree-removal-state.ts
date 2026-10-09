import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { PreservedWorktreeBranch } from '../shared/worktree/create-types'
import type { RuntimeWorktreeRemovalState } from '../shared/runtime-worktree-contracts'
import { splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import {
  failedWorktreeRemovals,
  pendingWorktreeRemovals,
  worktreeCheckoutExists
} from './worktree-removal-table'

/**
 * Derives a removal's outcome from what the host already keeps: the pending and failed removal
 * records, Git's listing, and the branch a finished delete kept. Only this host's local checkouts
 * are removed in the background, so other hosts read only the listing.
 */
export async function readWorktreeRemovalState(
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  read: {
    isListed: () => Promise<boolean>
    preservedBranch: () => PreservedWorktreeBranch | undefined
  }
): Promise<RuntimeWorktreeRemovalState> {
  const local = (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
  if (local && pendingWorktreeRemovals.has(worktreeId)) {
    return { state: 'removing' }
  }
  const failure = local ? failedWorktreeRemovals.get(worktreeId)?.failure : undefined
  if (failure) {
    return { state: 'failed', message: failure.message }
  }
  // Why after the records: a settled delete leaves them before this lists Git, so a listed row is
  // one the delete did not take, not one still being deleted. The folder check keeps `removed`
  // true to its word when Git's listing could not see the leftover.
  const checkoutPath = local ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath : undefined
  if (
    (await read.isListed()) ||
    (checkoutPath !== undefined && (await worktreeCheckoutExists(checkoutPath)))
  ) {
    return { state: 'present' }
  }
  const preservedBranch = read.preservedBranch()
  return { state: 'removed', ...(preservedBranch ? { preservedBranch } : {}) }
}
