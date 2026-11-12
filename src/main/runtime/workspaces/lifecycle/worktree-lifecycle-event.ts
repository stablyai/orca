import type { ExecutionHostId } from '../../../../shared/execution-host'

/** Host-qualified identity of the worktree, when it has one. Captured before a removal purges
 *  the metadata row, since listeners hear `removed` only after. */
type WorktreeLifecycleIdentity = { identityKey?: string; hostId?: ExecutionHostId }

export type RuntimeWorktreeLifecycleEvent =
  | ({
      kind: 'created'
      worktreeId: string
      path: string
      branch: string
    } & WorktreeLifecycleIdentity)
  | ({ kind: 'removed'; worktreeId: string; path: string } & WorktreeLifecycleIdentity)

/** A created worktree's identity, from the row Orca just built for it. */
export function createdWorktreeLifecycleIdentity(worktree: {
  identity?: { key: string }
  hostId?: ExecutionHostId
}): WorktreeLifecycleIdentity {
  return {
    ...(worktree.identity ? { identityKey: worktree.identity.key } : {}),
    ...(worktree.hostId ? { hostId: worktree.hostId } : {})
  }
}
