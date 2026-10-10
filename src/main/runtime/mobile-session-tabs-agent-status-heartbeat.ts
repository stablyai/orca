import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'

// Refresh halfway through the stale lease so a bounded global queue has ample drain time.
export const SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS = AGENT_STATUS_STALE_AFTER_MS / 2
export const SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS = 50

export type MobileSessionTabsAgentStatusHeartbeat = {
  observeSemanticTitle: (ptyId: string) => void
  observeWorktreeRefresh: (worktreeId: string) => void
  scheduleDecorativeHeartbeat: (ptyId: string) => void
  scheduleWorktreeHeartbeat: (worktreeId: string) => void
  removePty: (ptyId: string) => void
  removeWorktree: (worktreeId: string) => void
  cancelPending: () => void
  dispose: () => void
}

export function createMobileSessionTabsAgentStatusHeartbeat(
  resolveWorktreeIds: (ptyId: string) => Iterable<string>,
  emit: (worktreeId: string) => void
): MobileSessionTabsAgentStatusHeartbeat {
  const lastEligibilityCheckAtByPtyId = new Map<string, number>()
  const lastRefreshAtByWorktreeId = new Map<string, number>()
  const pendingByWorktreeId = new Map<string, { directObservation: boolean; ptyIds: Set<string> }>()
  let lastGlobalHeartbeatAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const observeWorktreeRefresh = (worktreeId: string, observedAt = Date.now()): void => {
    lastRefreshAtByWorktreeId.set(worktreeId, observedAt)
    pendingByWorktreeId.delete(worktreeId)
    if (pendingByWorktreeId.size === 0) {
      clearTimer()
    }
  }

  const arm = (): void => {
    if (timer !== null || pendingByWorktreeId.size === 0) {
      return
    }
    const now = Date.now()
    const delay =
      lastGlobalHeartbeatAt === null
        ? 0
        : Math.max(
            0,
            SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS - (now - lastGlobalHeartbeatAt)
          )
    timer = setTimeout(() => {
      timer = null
      const worktreeId = pendingByWorktreeId.keys().next().value
      if (typeof worktreeId !== 'string') {
        return
      }
      const pending = pendingByWorktreeId.get(worktreeId)
      pendingByWorktreeId.delete(worktreeId)
      const emittedAt = Date.now()
      lastRefreshAtByWorktreeId.set(worktreeId, emittedAt)
      for (const ptyId of pending?.ptyIds ?? []) {
        lastEligibilityCheckAtByPtyId.set(ptyId, emittedAt)
      }
      lastGlobalHeartbeatAt = emittedAt
      emit(worktreeId)
      arm()
    }, delay)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  const scheduleWorktreeHeartbeat = (worktreeId: string, ptyId?: string): void => {
    const now = Date.now()
    const lastRefreshAt = lastRefreshAtByWorktreeId.get(worktreeId)
    if (
      lastRefreshAt !== undefined &&
      now - lastRefreshAt < SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS
    ) {
      return
    }
    const pending = pendingByWorktreeId.get(worktreeId) ?? {
      directObservation: false,
      ptyIds: new Set<string>()
    }
    if (ptyId) {
      pending.ptyIds.add(ptyId)
    } else {
      pending.directObservation = true
    }
    pendingByWorktreeId.set(worktreeId, pending)
    arm()
  }

  return {
    observeSemanticTitle(ptyId: string): void {
      const observedAt = Date.now()
      lastEligibilityCheckAtByPtyId.set(ptyId, observedAt)
      for (const worktreeId of resolveWorktreeIds(ptyId)) {
        observeWorktreeRefresh(worktreeId, observedAt)
      }
    },
    observeWorktreeRefresh,
    scheduleDecorativeHeartbeat(ptyId: string): void {
      const now = Date.now()
      const lastEligibilityCheckAt = lastEligibilityCheckAtByPtyId.get(ptyId)
      if (
        lastEligibilityCheckAt !== undefined &&
        now - lastEligibilityCheckAt < SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS
      ) {
        return
      }
      lastEligibilityCheckAtByPtyId.set(ptyId, now)
      for (const worktreeId of resolveWorktreeIds(ptyId)) {
        scheduleWorktreeHeartbeat(worktreeId, ptyId)
      }
    },
    scheduleWorktreeHeartbeat,
    removePty(ptyId: string): void {
      lastEligibilityCheckAtByPtyId.delete(ptyId)
      for (const [worktreeId, pending] of pendingByWorktreeId) {
        pending.ptyIds.delete(ptyId)
        if (pending.ptyIds.size === 0 && !pending.directObservation) {
          pendingByWorktreeId.delete(worktreeId)
        }
      }
      if (pendingByWorktreeId.size === 0) {
        clearTimer()
      }
    },
    removeWorktree(worktreeId: string): void {
      lastRefreshAtByWorktreeId.delete(worktreeId)
      pendingByWorktreeId.delete(worktreeId)
      if (pendingByWorktreeId.size === 0) {
        clearTimer()
      }
    },
    cancelPending(): void {
      clearTimer()
      pendingByWorktreeId.clear()
    },
    dispose(): void {
      clearTimer()
      pendingByWorktreeId.clear()
      lastEligibilityCheckAtByPtyId.clear()
      lastRefreshAtByWorktreeId.clear()
      lastGlobalHeartbeatAt = null
    }
  }
}
