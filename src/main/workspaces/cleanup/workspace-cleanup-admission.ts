import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { WorkspaceCleanupWorkspaceRef } from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'

type CleanupAdmission<T> =
  | { admitted: false; cause: 'pinned' | 'git-unknown' }
  | { admitted: true; completion: Promise<T> }

const admissions = new WeakMap<RuntimeStore, Map<string, string>>()

export function hasWorkspaceCleanupAdmission(
  store: RuntimeStore,
  worktreeId: string,
  instanceId: string
): boolean {
  return admissions.get(store)?.get(worktreeId) === instanceId
}

/** Publish admission under the pin writer even when the optional lifecycle queue is disabled. */
export async function admitWorkspaceCleanup<T>(
  store: RuntimeStore,
  ref: WorkspaceCleanupWorkspaceRef,
  submit: () => Promise<T>
): Promise<CleanupAdmission<T>> {
  const { worktreeId, instanceId } = ref
  if (!store.runDurableMutation) {
    return { admitted: false, cause: 'git-unknown' }
  }
  return store.runDurableMutation<CleanupAdmission<T>>(() => {
    const meta = readWorktreeMetaForHost(store, worktreeId, LOCAL_EXECUTION_HOST_ID)
    if (!instanceId || meta?.instanceId !== instanceId) {
      return { value: { admitted: false as const, cause: 'git-unknown' as const }, persist: false }
    }
    if (meta.isPinned) {
      return { value: { admitted: false as const, cause: 'pinned' as const }, persist: false }
    }
    const admitted = admissions.get(store) ?? new Map<string, string>()
    admissions.set(store, admitted)
    admitted.set(worktreeId, instanceId)
    const completion = Promise.resolve().then(submit)
    void completion
      .finally(() => {
        const current = readWorktreeMetaForHost(store, worktreeId, LOCAL_EXECUTION_HOST_ID)
        // A retained/uncertain incarnation stays fenced; removed rows need no tombstone.
        if (current?.instanceId !== instanceId && admitted.get(worktreeId) === instanceId) {
          admitted.delete(worktreeId)
        }
      })
      .catch(() => undefined)
    return { value: { admitted: true as const, completion }, persist: false }
  })
}
