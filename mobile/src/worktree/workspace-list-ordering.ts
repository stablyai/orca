import type { Worktree } from './workspace-list-types'
import type { WorkspaceSortBy } from '../../../src/shared/workspace-view/workspace-view-options'
import {
  buildWorkspaceRowComparator,
  recentActivityWithCreateGrace
} from '../../../src/shared/workspace-view/workspace-row-sort'
import { compareCodePoints, compareSidebarText } from '../../../src/shared/sidebar-list/text-order'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'
import {
  compareSmartStamps,
  recentStamp,
  type StampOrderRow
} from '../../../src/shared/sidebar-list/stamp-order'

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function getManualSortRank(worktree: Worktree): number | null {
  const rank = worktree.manualOrder ?? worktree.sortOrder
  return typeof rank === 'number' && Number.isFinite(rank) ? rank : null
}

// The phone's row names the unread flag `unread`.
function stampRow(worktree: Worktree): StampOrderRow {
  return {
    lastActivityAt: worktree.lastActivityAt,
    smartTier: worktree.smartTier,
    smartAt: worktree.smartAt,
    isUnread: worktree.unread
  }
}

export function hostSortsByStamps(worktrees: readonly Worktree[]): boolean {
  return worktrees.some((worktree) => worktree.sortedByStamps)
}

const AGENT_ATTENTION_STATUS_ORDER = { permission: 0, working: 1, done: 2, active: 3, inactive: 4 }

export function sortWorktrees(
  worktrees: Worktree[],
  mode: WorkspaceSortBy,
  now = Date.now(),
  // Read from the unfiltered list, so a filter never switches the algorithm.
  byStamps = hostSortsByStamps(worktrees)
): Worktree[] {
  // A stamping host decides the order; rows from an older one rest by Recent among them.
  if (byStamps) {
    return [...worktrees].sort(
      buildWorkspaceRowComparator<Worktree>(mode, {
        label: (w) => w.displayName,
        identity: getWorktreeRowIdentity,
        repoLabel: (w) => w.repo,
        recentActivity: recentStamp,
        manualRank: getManualSortRank,
        compareSmart: (a, b) => compareSmartStamps(stampRow(a), stampRow(b))
      })
    )
  }
  // Why lastOutputAt too: headless serve hosts only stamp lastActivityAt at creation, so live
  // terminal output must still count as recency for mobile-only pairings.
  const recentActivity = (w: Worktree): number =>
    recentActivityWithCreateGrace(
      Math.max(finiteOr(w.lastActivityAt, 0), finiteOr(w.lastOutputAt, 0)),
      w.createdAt,
      now
    )
  const compareRecent = (a: Worktree, b: Worktree): number =>
    recentActivity(b) - recentActivity(a) ||
    compareSidebarText(a.displayName, b.displayName) ||
    compareCodePoints(getWorktreeRowIdentity(a), getWorktreeRowIdentity(b))
  return [...worktrees].sort(
    buildWorkspaceRowComparator<Worktree>(mode, {
      label: (w) => w.displayName,
      identity: getWorktreeRowIdentity,
      repoLabel: (w) => w.repo,
      recentActivity,
      manualRank: getManualSortRank,
      compareSmart: (a, b) => {
        const aRank = finiteOr(a.sortOrder, 0)
        const bRank = finiteOr(b.sortOrder, 0)
        if (aRank !== bRank) {
          // Why: desktop persists its computed Agent activity order into sortOrder.
          return bRank - aRank
        }
        if (aRank !== 0) {
          return 0
        }
        // Why: headless serve hosts never persist desktop smart ranks; unranked rows fall back to
        // agent attention, then recency, instead of a frozen A-Z list.
        return (
          AGENT_ATTENTION_STATUS_ORDER[getWorktreeStatus(a)] -
            AGENT_ATTENTION_STATUS_ORDER[getWorktreeStatus(b)] || compareRecent(a, b)
        )
      }
    })
  )
}

export function getWorktreeStatus(
  w: Worktree
): 'working' | 'active' | 'permission' | 'done' | 'inactive' {
  // Why: desktop's sidebar activity is the parity source. Runtime status may
  // still report retained/background PTYs as active after desktop hides them.
  if (w.hasHostSidebarActivity === false) {
    return 'inactive'
  }
  if (w.status && w.status !== 'inactive') {
    return w.status
  }
  if (w.hasHostSidebarActivity === true) {
    return 'active'
  }
  if (w.status) {
    return w.status
  }
  if (w.liveTerminalCount > 0) {
    return 'active'
  }
  return 'inactive'
}
