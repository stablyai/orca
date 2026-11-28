import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import {
  resolveWorktreeLaunchHost,
  type LaunchHostRepo
} from '../../workspaces/catalog/worktree-launch-host-repo'
import type { WorktreePtyHostFence } from '../../workspaces/removal/worktree-pty-host-fence'
import type { PtyList } from '../records/runtime-terminal-state-records'
import { tabListOfPty } from '../../session-tabs/person/person-workspace-target'

/** Host-scope sleep keys so same-id twins cannot wake or block one another's spawns. */
export function hostSleepKey(hostId: ExecutionHostId, worktreeId: string): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(hostId, worktreeIdentityKey(worktreeId))
}

/** One host's copy of a worktree's tab list, as a sleep stops and records it. */
export type WorktreeSleepScope = {
  key: HostScopedWorktreeKey
  /** Which live PTYs are this copy's; a twin's PTYs are never stopped or filed under `key`. */
  fence: WorktreePtyHostFence
  /** Whose terminals: the host list's, or a teammate's own list's in a shared agent's Home. */
  list: PtyList
  /** The list's workspace, which its sleep state, events and resume records name: the workspace
   *  itself for the host list, the teammate's own workspace (`person:`) for theirs. */
  listWorkspaceId: string
}

/** The workspace a list's sleep is keyed, told and recorded by: the workspace itself for the host
 *  list, the teammate's own (`person:`) for theirs, so one list's sleep never wakes, blocks or
 *  replays as another's. */
export function listSleepWorkspaceId(worktreeId: string, list: PtyList = 'host'): string {
  return list === 'host' ? worktreeId : tabListOfPty({ holder: list, worktreeId })
}

/** Use the launch host resolver and refuse ambiguity. Capture once: repo retargeting while asleep must not move the slept host's record. */
export function resolveSleepScope(
  repos: readonly LaunchHostRepo[],
  worktree: { id: string; repoId: string; hostId?: string | null },
  list: PtyList = 'host'
): WorktreeSleepScope {
  const launch = resolveWorktreeLaunchHost(repos, worktree)
  if (launch.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  const listWorkspaceId = listSleepWorkspaceId(worktree.id, list)
  return {
    key: hostSleepKey(getConnectionExecutionHostId(launch.connectionId), listWorkspaceId),
    fence: { resolvedConnectionId: launch.connectionId },
    list,
    listWorkspaceId
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
