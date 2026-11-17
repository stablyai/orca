import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { WorkspaceCleanupWorkspaceRef } from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'

type CleanupAdmission<T> =
  | { admitted: false; cause: 'pinned' | 'git-unknown' }
  | { admitted: true; completion: Promise<T> }

/** Pin durability and new automatic admission share the owner writer, with no await before submit. */
export async function admitWorkspaceCleanup<T>(
  store: RuntimeStore,
  ref: WorkspaceCleanupWorkspaceRef,
  submit: () => Promise<T>
): Promise<CleanupAdmission<T>> {
  if (!store.runDurableMutation) {
    return { admitted: false, cause: 'git-unknown' }
  }
  return store.runDurableMutation<CleanupAdmission<T>>(() => {
    const meta = readWorktreeMetaForHost(store, ref.worktreeId, LOCAL_EXECUTION_HOST_ID)
    if (!ref.instanceId || meta?.instanceId !== ref.instanceId) {
      return { value: { admitted: false as const, cause: 'git-unknown' as const }, persist: false }
    }
    if (meta.isPinned) {
      return { value: { admitted: false as const, cause: 'pinned' as const }, persist: false }
    }
    const completion = submit()
    void completion.catch(() => undefined)
    return { value: { admitted: true as const, completion }, persist: false }
  })
}
