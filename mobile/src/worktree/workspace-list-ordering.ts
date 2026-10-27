import type { Worktree } from './workspace-list-types'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
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
  // Headless hosts stamp lastActivityAt only at creation, so terminal output must count toward recency.
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
          return bRank - aRank
        }
        if (aRank !== 0) {
          return 0
        }
        // Headless hosts lack desktop smart ranks; fall back to attention then recency.
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
  // Match desktop sidebar activity; retained/background PTYs alone must not imply an active workspace.
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

// Only the host sees agent verdicts; older hosts omit sidebarStatus, and activity stays the phone's rule above.
const HOST_VERDICT_DOT_STATUSES: ReadonlySet<string> = new Set<WorktreeStatus>([
  'permission',
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  'interrupted',
  'done'
])

function isHostVerdictDotStatus(value: string | undefined): value is WorktreeStatus {
  return value !== undefined && HOST_VERDICT_DOT_STATUSES.has(value)
}

export function getWorktreeDotStatus(w: Worktree): WorktreeStatus {
  return isHostVerdictDotStatus(w.sidebarStatus) ? w.sidebarStatus : getWorktreeStatus(w)
}
