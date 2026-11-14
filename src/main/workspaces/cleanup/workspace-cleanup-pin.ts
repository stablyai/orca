import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'

type PinRuntime = Pick<OrcaRuntimeService, 'requireStore'> & {
  getWorktreePs: (...args: Parameters<OrcaRuntimeService['getWorktreePs']>) => Promise<{
    truncated: boolean
    worktrees: Pick<
      RuntimeWorktreePsSummary,
      'worktreeId' | 'hostId' | 'worktreeInstanceId' | 'removing'
    >[]
  }>
}

/** Revalidate incarnation inside the durable mutation; a reused locator must never inherit Keep. */
export async function pinWorkspaceForCleanup(
  runtime: PinRuntime,
  worktreeId: string,
  instanceId: string
): Promise<void> {
  const store = runtime.requireStore()
  if (!store.runDurableMutation) {
    throw new Error('workspace_cleanup_pin_unsupported')
  }
  const ps = await runtime.getWorktreePs(100_000, true, false, worktreeId)
  if (ps.truncated) {
    throw new Error('workspace_cleanup_identity_unknown')
  }
  const row = ps.worktrees.find(
    (item) =>
      item.worktreeId === worktreeId && (!item.hostId || item.hostId === LOCAL_EXECUTION_HOST_ID)
  )
  if (!row || row.worktreeInstanceId !== instanceId || row.removing) {
    throw new Error('workspace_cleanup_kept_workspace_deleted')
  }
  const pinned = await store.runDurableMutation(() => {
    const meta = readWorktreeMetaForHost(store, worktreeId, LOCAL_EXECUTION_HOST_ID)
    if (!meta || meta.instanceId !== instanceId) {
      return { value: false, persist: false }
    }
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID }), {
      isPinned: true
    })
    return { value: true }
  })
  if (!pinned) {
    throw new Error('workspace_cleanup_kept_workspace_deleted')
  }
}
