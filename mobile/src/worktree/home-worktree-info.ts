import type { AgentWorkingMode } from '../../../src/shared/agent-status-types'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'

export type HomeWorktreeSummary = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  hasHostSidebarActivity?: boolean
  unread?: boolean
  isArchived?: boolean
  isActive?: boolean
  lastOutputAt?: number
  sidebarStatus?: string
  workingMode?: AgentWorkingMode
}

/** A workspace whose agents Home surfaces under "Jump back in", with the list's dot status. */
export type HomeAttentionWorktree = Pick<
  HomeWorktreeSummary,
  'worktreeId' | 'repo' | 'branch' | 'displayName' | 'lastOutputAt' | 'workingMode'
> & { dotStatus: WorktreeStatus }

export type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: HomeWorktreeSummary | null
  attention?: HomeAttentionWorktree[]
  catalogUnavailable?: boolean
  // The counts are the last proven ones, kept across a failed refresh.
  staleCounts?: boolean
  // Epoch ms of the last proven counts; older snapshots without it have unknown age and count as expired.
  countsProvenAt?: number
}

// Persisted counts may be days old; bound their live label without discarding history.
export const HOME_WORKTREE_COUNTS_LIVE_MAX_AGE_MS = 10 * 60_000

/** Agent states are live facts; a saved copy or a dropped connection can't vouch for them. */
export function withoutHomeAgentStates(info: HostWorktreeInfo): HostWorktreeInfo {
  if (!info.attention) {
    return info
  }
  const { attention: _attention, ...rest } = info
  return rest
}

export function markHomeWorktreeCatalogUnavailable(
  current: HostWorktreeInfo | undefined,
  hostId: string
): HostWorktreeInfo {
  if (current?.catalogUnavailable) {
    return current
  }
  if (current) {
    // A dropped socket cannot disprove prior counts; retain them as stale.
    return { ...current, catalogUnavailable: true, staleCounts: true }
  }
  return {
    hostId,
    totalWorktrees: 0,
    activeCount: 0,
    lastActiveWorktree: null,
    catalogUnavailable: true
  }
}

/** The host card's worktree line, or null when nothing is known yet. */
export function homeHostWorktreeSummary(
  info: HostWorktreeInfo | undefined,
  now: number = Date.now()
): string | null {
  if (!info) {
    return null
  }
  // Never claim a count the host has not proven (STA-3123).
  if (info.catalogUnavailable && !info.staleCounts) {
    return 'Worktree list unavailable'
  }
  const counts = `${info.totalWorktrees} worktree${info.totalWorktrees === 1 ? '' : 's'}${
    info.activeCount > 0 ? ` · ${info.activeCount} active` : ''
  }`
  // Keep historical counts after age-out or refresh failure, but stop labeling them current.
  return info.staleCounts || !provenRecently(info, now) ? `Last known: ${counts}` : counts
}

function provenRecently(info: HostWorktreeInfo, now: number): boolean {
  return (
    typeof info.countsProvenAt === 'number' &&
    now - info.countsProvenAt <= HOME_WORKTREE_COUNTS_LIVE_MAX_AGE_MS
  )
}
