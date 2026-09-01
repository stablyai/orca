import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

/**
 * The listing paths take partial store shapes (`Pick<Store, ...>`), so the
 * host-qualified accessors are optional here and fall back to the locator-keyed
 * ones. A real Store always has them.
 */
export type HostQualifiedWorktreeMetaStore = {
  getAllWorktreeMeta: () => Record<string, WorktreeMeta>
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
  getAllWorktreeMetaForHost?: (executionHostId: ExecutionHostId) => Record<string, WorktreeMeta>
  setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => WorktreeMeta
  setWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId,
    meta: Partial<WorktreeMeta>
  ) => WorktreeMeta
}

/** Canonical host snapshot, with a filtered legacy fallback for partial test/compatibility stores. */
export function readAllWorktreeMetaForHost(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost'>,
  executionHostId: ExecutionHostId
): Record<string, WorktreeMeta> {
  const qualified = store.getAllWorktreeMetaForHost?.(executionHostId)
  if (qualified) {
    return qualified
  }
  const projected: Record<string, WorktreeMeta> = {}
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  return projected
}

/**
 * The row this host owns at `worktreeId`, or undefined. Deliberately does NOT fall back to the
 * locator-keyed read: that would hand one host's metadata to another's row, which is the collision
 * every caller here is trying to avoid. Callers keep their own same-id ownership guard as fallback.
 */
export function readWorktreeMetaForHost(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getWorktreeMetaForHost'>,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMeta | undefined {
  return store.getWorktreeMetaForHost?.(worktreeId, executionHostId)
}

export function writeWorktreeMetaForHost(
  store: Pick<HostQualifiedWorktreeMetaStore, 'setWorktreeMeta' | 'setWorktreeMetaForHost'>,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  meta: Partial<WorktreeMeta>
): WorktreeMeta {
  return (
    store.setWorktreeMetaForHost?.(worktreeId, executionHostId, meta) ??
    store.setWorktreeMeta(worktreeId, { ...meta, hostId: executionHostId })
  )
}
