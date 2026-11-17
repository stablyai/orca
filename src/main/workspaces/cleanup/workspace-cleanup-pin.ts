import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import { workspaceLifecycleKey } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'

type PinRuntime = Pick<OrcaRuntimeService, 'requireStore'> & {
  workspaceLifecycle?: OrcaRuntimeService['workspaceLifecycle']
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
  const result = await pinWorkspacesForCleanup(runtime, [{ worktreeId, instanceId }])
  if (result.deleted.length || result.failed.length) {
    throw new Error('workspace_cleanup_kept_workspace_deleted')
  }
}

export async function pinWorkspacesForCleanup(
  runtime: PinRuntime,
  rows: readonly { worktreeId: string; instanceId: string }[]
): Promise<{ pinned: string[]; deleted: string[]; failed: string[] }> {
  if (!rows.length) {
    return { pinned: [], deleted: [], failed: [] }
  }
  if (rows.length > 100_000) {
    throw new Error('workspace_cleanup_pin_batch_too_large')
  }
  const store = runtime.requireStore()
  if (!store.runDurableMutation) {
    throw new Error('workspace_cleanup_pin_unsupported')
  }
  const ps = await runtime.getWorktreePs(100_000, true, false)
  if (ps.truncated) {
    throw new Error('workspace_cleanup_identity_unknown')
  }
  const inventory = new Map(
    ps.worktrees
      .filter((item) => !item.hostId || item.hostId === LOCAL_EXECUTION_HOST_ID)
      .map((item) => [item.worktreeId, item])
  )
  return store.runDurableMutation(() => {
    const result: { pinned: string[]; deleted: string[]; failed: string[] } = {
      pinned: [],
      deleted: [],
      failed: []
    }
    const lifecycle = runtime.workspaceLifecycle?.hints() ?? {}
    for (const { worktreeId, instanceId } of rows) {
      const row = inventory.get(worktreeId)
      const meta = readWorktreeMetaForHost(store, worktreeId, LOCAL_EXECUTION_HOST_ID)
      if (
        !row ||
        row.worktreeInstanceId !== instanceId ||
        row.removing ||
        meta?.instanceId !== instanceId ||
        lifecycle[workspaceLifecycleKey(LOCAL_EXECUTION_HOST_ID, worktreeId)]?.kind === 'delete'
      ) {
        result.deleted.push(worktreeId)
        continue
      }
      try {
        store.setWorktreeMeta(
          hostWorktreeTarget({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID }),
          {
            isPinned: true
          }
        )
        result.pinned.push(worktreeId)
      } catch {
        result.failed.push(worktreeId)
      }
    }
    return { value: result }
  })
}
