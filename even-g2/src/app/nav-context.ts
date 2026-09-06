// Integrator wiring (Unit 8, spec S10 integrator notes #1/#2): builds reduceHudInput's
// read-only NavContext from live HudState. v1 keeps one host connected at a time (spec S6), so
// "this host's data" means "the currently connected host's data".
import { DEFAULT_ASK_OPTION_COUNT } from '../screens/ask-screen'
import { dashboardPageCount as computeDashboardPageCount } from '../screens/dashboard-screen'
import { terminalTailPageCount as computeTerminalTailPageCount } from '../screens/terminal-tail-screen'
import { worktreeListPageCount as computeWorktreeListPageCount } from '../screens/worktree-list-screen'
import type { NavContext } from '../navigation/nav-contract'
import { currentAsk } from '../state/notification-inbox-state'
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
    // Finding #5/#13: delegate to the single `currentAsk` selector (notification-inbox-state.ts)
    // shared with the header nudge and click routing, scoped to "this is the connected host" —
    // v1 keeps one host connected at a time, so dashboard/inbox slices are always that host's.
    pendingAskNotificationId: (hostId) => {
      if (state.connection.hostId !== hostId) {
        return null
      }
      return currentAsk(state)?.notificationId ?? null
    },
    askOptionCount: () => DEFAULT_ASK_OPTION_COUNT,
    hostIdAt: (index) => state.hosts[index]?.id ?? null,
    worktreeIdAt: (hostId, index) => rowsForHost(state, hostId)[index]?.worktreeId ?? null,
    notificationWorktreeId: (notificationId) => {
      const fromInbox = state.inbox.entries.find(
        (e) => e.notificationId === notificationId
      )?.worktreeId
      if (fromInbox !== undefined) {
        return fromInbox
      }
      // Finding #14: currentAsk() can synthesize a notificationId with no backing inbox entry
      // when a blocked worktree never produced a notification — resolve it the same way.
      const ask = currentAsk(state)
      return ask && ask.notificationId === notificationId ? ask.worktreeId : null
    },
    // CRITICAL #11: blocks a second sendAskAnswer while one is in flight, and blocks retry
    // entirely once an attempt left the outcome unknown (never guess a second time).
    askSendInFlight: (worktreeId) => {
      const interaction = state.askInteraction
      return (
        interaction !== null &&
        interaction.worktreeId === worktreeId &&
        (interaction.phase === 'sending' ||
          interaction.phase === 'checking' ||
          interaction.phase === 'unresolved')
      )
    }
  }
}
