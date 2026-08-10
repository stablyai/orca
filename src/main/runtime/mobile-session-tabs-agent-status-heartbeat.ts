import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'

// Refresh halfway through the stale lease so a bounded global queue has ample drain time.
export const SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS = AGENT_STATUS_STALE_AFTER_MS / 2
export const SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS = 50

export type MobileSessionTabsAgentStatusHeartbeat = {
  observeSemanticTitle: (ptyId: string) => void
  scheduleDecorativeHeartbeat: (ptyId: string) => void
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
  const pendingPtyIdsByWorktreeId = new Map<string, Set<string>>()
  let lastGlobalHeartbeatAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const arm = (): void => {
    if (timer !== null || pendingPtyIdsByWorktreeId.size === 0) {
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
      const worktreeId = pendingPtyIdsByWorktreeId.keys().next().value
      if (typeof worktreeId !== 'string') {
        return
      }
      const pendingPtyIds = pendingPtyIdsByWorktreeId.get(worktreeId)
      pendingPtyIdsByWorktreeId.delete(worktreeId)
      const emittedAt = Date.now()
      lastRefreshAtByWorktreeId.set(worktreeId, emittedAt)
      for (const ptyId of pendingPtyIds ?? []) {
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

  return {
    observeSemanticTitle(ptyId: string): void {
      const observedAt = Date.now()
      lastEligibilityCheckAtByPtyId.set(ptyId, observedAt)
      for (const worktreeId of resolveWorktreeIds(ptyId)) {
        lastRefreshAtByWorktreeId.set(worktreeId, observedAt)
        pendingPtyIdsByWorktreeId.delete(worktreeId)
      }
      if (pendingPtyIdsByWorktreeId.size === 0) {
        clearTimer()
      }
    },
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
        const lastRefreshAt = lastRefreshAtByWorktreeId.get(worktreeId)
        if (
          lastRefreshAt === undefined ||
          now - lastRefreshAt >= SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS
        ) {
          const pendingPtyIds = pendingPtyIdsByWorktreeId.get(worktreeId) ?? new Set<string>()
          pendingPtyIds.add(ptyId)
          pendingPtyIdsByWorktreeId.set(worktreeId, pendingPtyIds)
        }
      }
      arm()
    },
    removePty(ptyId: string): void {
      lastEligibilityCheckAtByPtyId.delete(ptyId)
      for (const [worktreeId, pendingPtyIds] of pendingPtyIdsByWorktreeId) {
        pendingPtyIds.delete(ptyId)
        if (pendingPtyIds.size === 0) {
          pendingPtyIdsByWorktreeId.delete(worktreeId)
        }
      }
      if (pendingPtyIdsByWorktreeId.size === 0) {
        clearTimer()
      }
    },
    removeWorktree(worktreeId: string): void {
      lastRefreshAtByWorktreeId.delete(worktreeId)
      pendingPtyIdsByWorktreeId.delete(worktreeId)
      if (pendingPtyIdsByWorktreeId.size === 0) {
        clearTimer()
      }
    },
    cancelPending(): void {
      clearTimer()
      pendingPtyIdsByWorktreeId.clear()
    },
    dispose(): void {
      clearTimer()
      pendingPtyIdsByWorktreeId.clear()
      lastEligibilityCheckAtByPtyId.clear()
      lastRefreshAtByWorktreeId.clear()
      lastGlobalHeartbeatAt = null
    }
  }
}
