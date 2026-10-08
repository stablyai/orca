import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ConnectionState } from '../transport/types'
import { serverHostHealth } from '../worktree/server-workspaces'
import { filterVisibleHostRows } from '../worktree/visible-host-rows'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import type { HostScreenState } from './use-host-screen-state'

/** The rows the host list renders: the live or last-known catalog with display state and host badges. */
export function useHostDisplayWorktrees(connState: ConnectionState, state: HostScreenState) {
  const { serverWorkspaces } = state
  // Why: a server's label and health come with its rows, alongside the desktop's SSH ones.
  const hostLabelById = useMemo(
    () => withServerHosts(state.hostLabelById, serverWorkspaces.hosts, (host) => host.label),
    [state.hostLabelById, serverWorkspaces.hosts]
  )
  const hostHealthById = useMemo(
    () => withServerHosts(state.hostHealthById, serverWorkspaces.hosts, serverHostHealth),
    [state.hostHealthById, serverWorkspaces.hosts]
  )
  return useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    const rows = filterVisibleHostRows(
      [...base, ...serverWorkspaces.worktrees],
      state.visibleHostIds,
      state.repoHostIdByRepoId
    )
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(rows, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      {
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        hostLabelById,
        hostPlatform: state.hostPlatform,
        hostHealthById
      }
    )
  }, [
    connState,
    state.worktrees,
    state.lastKnownWorktrees,
    serverWorkspaces.worktrees,
    state.visibleHostIds,
    state.sleptIds,
    state.optimisticActiveWorktreeIdentity,
    state.repoHostIdByRepoId,
    hostLabelById,
    state.hostPlatform,
    hostHealthById
  ])
}

function withServerHosts<Value>(
  desktop: ReadonlyMap<ExecutionHostId, Value>,
  hosts: HostScreenState['serverWorkspaces']['hosts'],
  read: (host: HostScreenState['serverWorkspaces']['hosts'][number]) => Value
): ReadonlyMap<ExecutionHostId, Value> {
  if (hosts.length === 0) {
    return desktop
  }
  const merged = new Map(desktop)
  for (const host of hosts) {
    merged.set(host.hostId, read(host))
  }
  return merged
}
