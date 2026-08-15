import type { MobileSessionTab } from './mobile-session-route-types'

/**
 * Whether the tab the user is looking at is a terminal the host published
 * without a PTY handle (`status: 'pending-handle'`). The session screen renders
 * a spinner for that tab and can only leave it when a snapshot carries the
 * materialized handle — so while this holds, the tabs reconciler must keep
 * asking. Without it a `live` stream parks the poll, and a host that mints the
 * handle without republishing strands the pane on the spinner forever
 * (STA-4256).
 *
 * Mirrors the route's `activePendingTerminalTab` derivation exactly, so this is
 * true precisely when the spinner is on screen.
 */
export function hasPendingTerminalHandleRecoveryNeed(
  tabs: readonly MobileSessionTab[],
  activeTabId: string | null
): boolean {
  if (activeTabId === null) {
    return false
  }
  const active = tabs.find((tab) => tab.id === activeTabId)
  return active?.type === 'terminal' && typeof active.terminal !== 'string'
}
