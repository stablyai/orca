import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

/**
 * Refuse a metadata write whose caller pinned a canonical identity that the current occupant of
 * the locator does not carry. Why here, in main: the renderer resolves the row, then the message
 * crosses IPC, and a checkout can be replaced at the same path in between. Local and direct-SSH
 * persistence had no identity selector, so the write landed on whichever occupant was current.
 * The runtime selector path already validates this way; this brings local IPC to parity.
 */
export function assertWorktreeMetaIdentity(
  meta: WorktreeMeta | undefined,
  worktreeId: string,
  identityKey: string | undefined
): void {
  if (identityKey === undefined) {
    return
  }
  const occupantKey =
    meta?.instanceId && meta.hostId
      ? canonicalWorktreeIdentity({
          worktreeId,
          executionHostId: meta.hostId,
          instanceId: meta.instanceId
        })
      : undefined
  if (occupantKey !== identityKey) {
    throw new Error('Workspace identity changed before the update was applied.')
  }
}
