import { useMemo } from 'react'
import { useHostDescriptor } from '../transport/host-descriptor-store'
import type { ConnectionState } from '../transport/types'
import { serverHostHealth, withServerHosts } from '../worktree/server-workspaces'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import type { HostScreenState } from './use-host-screen-state'

/** The rows the host list renders: the live or last-known catalog with display state and host badges. */
export function useHostDisplayWorktrees(
  connState: ConnectionState,
  state: HostScreenState,
  hostId: string | undefined
) {
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
  const descriptorPlatform = useHostDescriptor(hostId)?.platform ?? null
  // Why: metadata reads the platform only for a mixed desktop catalog; server rows mix it too.
  const hostPlatform = state.hostPlatform ?? descriptorPlatform
  return useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    const rows = [...base, ...serverWorkspaces.worktrees]
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(rows, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      {
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        hostLabelById,
        hostPlatform,
        hostHealthById
      }
    )
  }, [
    connState,
    state.worktrees,
    state.lastKnownWorktrees,
    serverWorkspaces.worktrees,
    state.sleptIds,
    state.optimisticActiveWorktreeIdentity,
    state.repoHostIdByRepoId,
    hostLabelById,
    hostPlatform,
    hostHealthById
  ])
}
