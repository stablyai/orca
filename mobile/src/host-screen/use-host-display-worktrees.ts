import { useMemo } from 'react'
import type { ConnectionState } from '../transport/types'
import { applyWorktreeHostContextLabels } from '../worktree/worktree-host-context-labels'
import { applyWorktreeRowDisplayState } from '../worktree/worktree-host-row-identity'
import type { HostScreenState } from './use-host-screen-state'

/** The rows the host list renders: the live or last-known catalog with display state and host badges. */
export function useHostDisplayWorktrees(connState: ConnectionState, state: HostScreenState) {
  return useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? state.worktrees : state.lastKnownWorktrees
    return applyWorktreeHostContextLabels(
      applyWorktreeRowDisplayState(base, state.sleptIds, state.optimisticActiveWorktreeIdentity),
      {
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        hostLabelById: state.hostLabelById,
        hostPlatform: state.hostPlatform,
        hostHealthById: state.hostHealthById
      }
    )
  }, [
    connState,
    state.worktrees,
    state.lastKnownWorktrees,
    state.sleptIds,
    state.optimisticActiveWorktreeIdentity,
    state.repoHostIdByRepoId,
    state.hostLabelById,
    state.hostPlatform,
    state.hostHealthById
  ])
}
