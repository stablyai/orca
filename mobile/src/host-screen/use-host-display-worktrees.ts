import { useMemo } from 'react'
import { useHostDescriptor } from '../transport/host-descriptor-store'
import type { ConnectionState } from '../transport/types'
import {
  serverHostHealth,
  serverHostHealthLabels,
  withServerHosts
} from '../worktree/server-workspaces'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import type { HostScreenState } from './use-host-screen-state'

/** The desktop's platform: its own report, or the paired descriptor's before that lands. */
export function useResolvedHostPlatform(
  state: HostScreenState,
  hostId: string | undefined
): NodeJS.Platform | null {
  const descriptorPlatform = useHostDescriptor(hostId)?.platform ?? null
  return state.hostPlatform ?? descriptorPlatform
}

export function useHostDisplayWorktrees(
  connState: ConnectionState,
  state: HostScreenState,
  hostPlatform: NodeJS.Platform | null
) {
  const { serverWorkspaces } = state
  const hostLabelById = useMemo(
    () => withServerHosts(state.hostLabelById, serverWorkspaces.hosts, (host) => host.label),
    [state.hostLabelById, serverWorkspaces.hosts]
  )
  const hostHealthById = useMemo(
    () => withServerHosts(state.hostHealthById, serverWorkspaces.hosts, serverHostHealth),
    [state.hostHealthById, serverWorkspaces.hosts]
  )
  const hostHealthLabelById = useMemo(
    () => serverHostHealthLabels(serverWorkspaces.hosts),
    [serverWorkspaces.hosts]
  )
  return useMemo(() => {
    // Use live rows only while connected; connecting/handshaking must preserve the cached list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    const rows = [...base, ...serverWorkspaces.worktrees]
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(rows, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      {
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        hostLabelById,
        hostPlatform,
        hostHealthById,
        hostHealthLabelById
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
    hostHealthById,
    hostHealthLabelById
  ])
}
