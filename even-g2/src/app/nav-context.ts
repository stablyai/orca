// Integrator wiring (Unit 8, spec S10 integrator notes #1/#2): builds reduceHudInput's
// read-only NavContext from live HudState. v1 keeps one host connected at a time (spec S6), so
// "this host's data" means "the currently connected host's data".
import { DEFAULT_ASK_OPTION_COUNT } from '../screens/ask-screen'
import { dashboardPageCount as computeDashboardPageCount } from '../screens/dashboard-screen'
import { terminalTailPageCount as computeTerminalTailPageCount } from '../screens/terminal-tail-screen'
import { worktreeListPageCount as computeWorktreeListPageCount } from '../screens/worktree-list-screen'
import type { NavContext } from '../navigation/nav-contract'
import type { DashboardRow, HudState } from '../state/hud-store'

function rowsForHost(state: HudState, hostId: string): DashboardRow[] {
  return state.connection.hostId === hostId ? state.dashboard.rows : []
}

export function buildNavContext(state: HudState): NavContext {
  return {
    hostCount: state.hosts.length,
    worktreeCount: (hostId) => rowsForHost(state, hostId).length,
    dashboardPageCount: (hostId) => computeDashboardPageCount(rowsForHost(state, hostId)),
    worktreeListPageCount: (hostId) =>
      computeWorktreeListPageCount(rowsForHost(state, hostId).length),
    terminalTailPageCount: (terminalId) =>
      state.terminalTail.terminalId === terminalId
        ? computeTerminalTailPageCount(state.terminalTail.lines)
        : 1,
    // Finding #5: an ask notification stays actionable only while its worktree's CURRENT
    // status is still `permission` — membership in the host's worktree set alone isn't enough,
    // otherwise an ask the agent already cleared (the next poll shows a different status)
    // remains re-openable/re-sendable from a stale inbox entry.
    pendingAskNotificationId: (hostId) => {
      const rows = rowsForHost(state, hostId)
      const entry = state.inbox.entries.find((e) => {
        if (e.kind !== 'ask' || e.worktreeId === undefined) {
          return false
        }
        return rows.find((row) => row.worktreeId === e.worktreeId)?.status === 'permission'
      })
      return entry?.notificationId ?? null
    },
    askOptionCount: () => DEFAULT_ASK_OPTION_COUNT,
    hostIdAt: (index) => state.hosts[index]?.id ?? null,
    worktreeIdAt: (hostId, index) => rowsForHost(state, hostId)[index]?.worktreeId ?? null,
    notificationWorktreeId: (notificationId) =>
      state.inbox.entries.find((e) => e.notificationId === notificationId)?.worktreeId ?? null
  }
}
