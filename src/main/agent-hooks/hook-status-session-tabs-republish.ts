import type { AgentHookServer } from './server'

type SessionTabsRepublisher = {
  getTerminalWorktreeIdForHandle(handle: string): string | null
  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null
  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId: string): void
  touchMobileSessionTabsForWorktree(worktreeId: string): void
}

type StatusStore = Pick<AgentHookServer, 'subscribeStatusFreshness' | 'subscribeStatusRowMutations'>

/**
 * Republish `session.tabs` whenever a pane's status row changes.
 *
 * Every producer — hook posts, the relay receivers, and main's own OSC parse — lands in the
 * store, so this is the one signal that a pane's published projection is out of date. Nothing
 * else republishes on a status-only transition, so a paired client would otherwise keep the
 * pane's last projection until an unrelated PTY touch came along (#7970).
 */
export function installHookStatusSessionTabsRepublish(
  statusStore: StatusStore,
  getRuntime: () => SessionTabsRepublisher | null | undefined
): () => void {
  const resolveWorktreeId = (
    identity: { paneKey: string; worktreeId?: string; terminalHandle?: string },
    runtime: SessionTabsRepublisher
  ): string | null =>
    identity.worktreeId ??
    (identity.terminalHandle
      ? runtime.getTerminalWorktreeIdForHandle(identity.terminalHandle)
      : null) ??
    runtime.getTerminalWorktreeIdForPaneKey(identity.paneKey)

  const unsubscribeMutations = statusStore.subscribeStatusRowMutations((mutation) => {
    const runtime = getRuntime()
    if (!runtime) {
      return
    }
    const worktreeIds = new Set<string>()
    for (const identity of [mutation.before, mutation.after]) {
      if (!identity) {
        continue
      }
      const worktreeId = resolveWorktreeId(identity, runtime)
      if (worktreeId) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const worktreeId of worktreeIds) {
      runtime.touchMobileSessionTabsForWorktree(worktreeId)
    }
  })
  const unsubscribeFreshness = statusStore.subscribeStatusFreshness((status) => {
    const runtime = getRuntime()
    if (!runtime) {
      return
    }
    const worktreeId = resolveWorktreeId(status, runtime)
    if (worktreeId) {
      runtime.scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId)
    }
  })
  return () => {
    unsubscribeMutations()
    unsubscribeFreshness()
  }
}
