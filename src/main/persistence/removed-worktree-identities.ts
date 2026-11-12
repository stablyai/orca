import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'

/** The identity key a worktree's metadata gives it, as `mergeWorktree` derives `identity.key`. */
export function worktreeMetaIdentityKey(
  worktreeId: string,
  meta: Pick<WorktreeMeta, 'instanceId' | 'hostId'> | undefined
): string | undefined {
  return meta?.instanceId && meta.hostId
    ? canonicalWorktreeIdentity({
        worktreeId,
        executionHostId: meta.hostId,
        instanceId: meta.instanceId
      })
    : undefined
}

const REMEMBERED_REMOVALS = 64
const removedIdentityKeys = new Map<string, string>()

/**
 * Keeps the identity of a metadata row being removed. Why: a removal's lifecycle event is emitted
 * after its row is purged, yet listeners still need the identity the row gave the worktree.
 */
export function rememberRemovedWorktreeIdentity(
  worktreeId: string,
  meta: Pick<WorktreeMeta, 'instanceId' | 'hostId'> | undefined
): void {
  const key = worktreeMetaIdentityKey(worktreeId, meta)
  if (!key) {
    return
  }
  removedIdentityKeys.delete(worktreeId)
  removedIdentityKeys.set(worktreeId, key)
  if (removedIdentityKeys.size > REMEMBERED_REMOVALS) {
    const oldest = removedIdentityKeys.keys().next()
    if (!oldest.done) {
      removedIdentityKeys.delete(oldest.value)
    }
  }
}

/** The identity key of the most recently removed row with this id, if still remembered. */
export function removedWorktreeIdentityKey(worktreeId: string): string | undefined {
  return removedIdentityKeys.get(worktreeId)
}
