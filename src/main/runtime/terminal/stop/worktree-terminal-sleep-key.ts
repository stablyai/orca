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

/**
 * Keys a worktree's sleep by the host its terminals run on: a same-id SSH twin is another
 * workspace, so its spawn must neither wake nor be refused by this copy's sleep.
 */
export function hostSleepKey(hostId: ExecutionHostId, worktreeId: string): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(hostId, worktreeIdentityKey(worktreeId))
}

/** One host's copy of a worktree, as a sleep stops and records it. */
export type WorktreeSleepScope = {
  key: HostScopedWorktreeKey
  /** Which live PTYs are this copy's; a twin's PTYs are never stopped or filed under `key`. */
  fence: WorktreePtyHostFence
}

/**
 * From the resolver the launch scope picks a spawn's connection with, so a sleep and the spawns of
 * one workspace always name one key. Rival rows that disagree refuse, as the launch does: a guessed
 * host would let the real host's spawns skip the sleep. Read once per sleep; a row re-pointed to
 * another host while asleep leaves the record under the host it was slept on.
 */
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
