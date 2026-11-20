import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { WorkspaceCleanupWorkspaceRef } from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { WorktreeRemovalNotStartedError } from '../removal/worktree-removal-expectation'
import { isWorktreeIdentityUnverifiable } from '../../../shared/worktree/removal/worktree-checkout-identity'

type CleanupAdmission<T> =
  | { admitted: false; cause: 'pinned' | 'git-unknown' | 'removing' }
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
    if (admitted.get(worktreeId) === instanceId) {
      return { value: { admitted: false as const, cause: 'removing' as const }, persist: false }
    }
    admissions.set(store, admitted)
    admitted.set(worktreeId, instanceId)
    const retire = (nonRemoval: boolean) =>
      store.runDurableMutation!(() => {
        const current = readWorktreeMetaForHost(store, worktreeId, LOCAL_EXECUTION_HOST_ID)
        if (
          (nonRemoval || current?.instanceId !== instanceId) &&
          admitted.get(worktreeId) === instanceId
        ) {
          admitted.delete(worktreeId)
        }
        return { value: undefined, persist: false }
      })
    const completion = Promise.resolve()
      .then(submit)
      .then(
        async (result) => {
          await retire(false)
          return result
        },
        async (error: unknown) => {
          // A route that couldn't verify the checkout refused before deleting anything.
          await retire(
            error instanceof WorktreeRemovalNotStartedError || isWorktreeIdentityUnverifiable(error)
          )
          throw error
        }
      )
    void completion.catch(() => undefined)
    return { value: { admitted: true as const, completion }, persist: false }
  })
}
