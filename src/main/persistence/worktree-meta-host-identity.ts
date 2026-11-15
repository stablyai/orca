import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { worktreeMetaIdentityKey } from '../../shared/worktree/identity'

type IdentityMeta = Pick<WorktreeMeta, 'instanceId' | 'hostId'>

/** The metadata reads a host-qualified identity lookup needs; real Stores provide both. */
export type WorktreeMetaIdentitySource = {
  getWorktreeMeta: (worktreeId: string) => IdentityMeta | undefined
  getWorktreeMetaForHost?: (worktreeId: string, hostId: ExecutionHostId) => IdentityMeta | undefined
}

/**
 * The identity key of `worktreeId` on `hostId`, from that host's metadata row only: a same-id
 * row of another host never lends its identity. Without a host, the row's own stamped host
 * decides, as removal does.
 */
export function worktreeHostIdentity(
  store: WorktreeMetaIdentitySource | null | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): { identityKey?: string; hostId?: ExecutionHostId } {
  const owner = hostId ?? store?.getWorktreeMeta(worktreeId)?.hostId
  if (!store || !owner) {
    return {}
  }
  const meta = store.getWorktreeMetaForHost
    ? store.getWorktreeMetaForHost(worktreeId, owner)
    : store.getWorktreeMeta(worktreeId)
  const identityKey = meta?.hostId === owner ? worktreeMetaIdentityKey(worktreeId, meta) : undefined
  return identityKey ? { identityKey, hostId: owner } : { hostId: owner }
}
