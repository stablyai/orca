import type { MobileSessionTab } from './mobile-session-route-types'

export const PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS = 5

export type PendingTerminalHandleRecoveryAttempt = {
  allowed: boolean
  parked: boolean
}

export class PendingTerminalHandleRecoveryBudget {
  private contextKey: string | null = null
  private remaining = PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS

  observeContext(contextKey: string | null): void {
    if (contextKey === this.contextKey) {
      return
    }
    this.contextKey = contextKey
    this.remaining = PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS
  }

  take(contextKey: string | null): PendingTerminalHandleRecoveryAttempt {
    this.observeContext(contextKey)
    if (contextKey === null) {
      return { allowed: false, parked: false }
    }
    if (this.remaining === 0) {
      return { allowed: false, parked: true }
    }
    this.remaining -= 1
    return { allowed: true, parked: false }
  }

  reset(): void {
    this.contextKey = null
    this.remaining = PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS
  }
}

export class PendingTerminalHandleRecoveryContextCache {
  private activeTabId: string | null = null
  private contextKey: string | null = null
  private initialized = false
  private tabs: readonly MobileSessionTab[] | null = null

  read(tabs: readonly MobileSessionTab[], activeTabId: string | null): string | null {
    if (this.initialized && tabs === this.tabs && activeTabId === this.activeTabId) {
      return this.contextKey
    }
    this.initialized = true
    this.tabs = tabs
    this.activeTabId = activeTabId
    this.contextKey = getPendingTerminalHandleRecoveryContextKey(tabs, activeTabId)
    return this.contextKey
  }
}

export function getPendingTerminalHandleRecoveryContextKey(
  tabs: readonly MobileSessionTab[],
  activeTabId: string | null
): string | null {
  if (activeTabId === null) {
    return null
  }
  const active = tabs.find((tab) => tab.id === activeTabId)
  if (active?.type !== 'terminal' || typeof active.terminal === 'string') {
    return null
  }
  return JSON.stringify([active.id, active.parentTabId, active.leafId ?? null])
}

// Poll while the selected terminal lacks a handle: live streams can miss materialization and otherwise leave the spinner forever. Match the route’s spinner predicate.
export function hasPendingTerminalHandleRecoveryNeed(
  tabs: readonly MobileSessionTab[],
  activeTabId: string | null
): boolean {
  return getPendingTerminalHandleRecoveryContextKey(tabs, activeTabId) !== null
}
