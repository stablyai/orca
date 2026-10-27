import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import { resolveWorktreeLaunchHost, type LaunchHostRepo } from '../../worktree-launch-host-repo'
import type { WorktreePtyHostFence } from '../../worktree-pty-host-fence'

/** Host-scope sleep keys so same-id twins cannot wake or block one another's spawns. */
export function hostSleepKey(hostId: ExecutionHostId, worktreeId: string): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(hostId, worktreeIdentityKey(worktreeId))
}

/** One host's copy of a worktree, as a sleep stops and records it. */
export type WorktreeSleepScope = {
  key: HostScopedWorktreeKey
  /** Which live PTYs are this copy's; a twin's PTYs are never stopped or filed under `key`. */
  fence: WorktreePtyHostFence
}

/** Use the launch host resolver and refuse ambiguity. Capture once: repo retargeting while asleep must not move the slept host's record. */
export function resolveSleepScope(
  repos: readonly LaunchHostRepo[],
  worktree: { id: string; repoId: string; hostId?: string | null }
): WorktreeSleepScope {
  const launch = resolveWorktreeLaunchHost(repos, worktree)
  if (launch.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  return {
    key: hostSleepKey(getConnectionExecutionHostId(launch.connectionId), worktree.id),
    fence: { resolvedConnectionId: launch.connectionId }
  }
}

/** Host-blind match, for readers that only know the bare workspace id. */
export function anySleepKeyNames(
  keys: Iterable<HostScopedWorktreeKey>,
  worktreeId: string
): boolean {
  const wanted = worktreeIdentityKey(worktreeId)
  for (const key of keys) {
    if (getWorktreeIdFromHostIdentity(key) === wanted) {
      return true
    }
  }
  return false
}
