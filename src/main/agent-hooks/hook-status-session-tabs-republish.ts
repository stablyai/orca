import type { AgentHookServer } from './server'

type SessionTabsRepublisher = {
  getTerminalWorktreeIdForHandle(handle: string): string | null
  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null
  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId: string): void
  touchMobileSessionTabsForWorktree(worktreeId: string): void
}

type StatusStore = Pick<AgentHookServer, 'subscribeStatusFreshness' | 'subscribeStatusRowMutations'>

/** Status-only changes need session.tabs republishing even without PTY activity. */
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
