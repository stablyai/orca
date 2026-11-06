import type { AgentWorkingMode } from '../../../src/shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
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
  agents?: RuntimeWorktreeAgentRow[]
}

/** A workspace whose agents Home surfaces under "Jump back in", with the list's dot status. */
export type HomeAttentionWorktree = Pick<
  HomeWorktreeSummary,
  'worktreeId' | 'repo' | 'branch' | 'displayName' | 'lastOutputAt' | 'workingMode'
> & {
  dotStatus: WorktreeStatus
  /** The conversation behind the dot and its pane; older hosts send no names. */
  conversationName?: string
  paneKey?: string
}

export type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: HomeWorktreeSummary | null
  attention?: HomeAttentionWorktree[]
  catalogUnavailable?: boolean
  // The counts are the last proven ones, kept across a failed refresh.
  staleCounts?: boolean
  // Epoch ms of the last proven counts.
  countsProvenAt?: number
}

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
export function homeHostWorktreeSummary(info: HostWorktreeInfo | undefined): string | null {
  if (!info) {
    return null
  }
  // Never claim a count the host has not proven (STA-3123).
  if (info.catalogUnavailable && !info.staleCounts) {
    return 'Worktree list unavailable'
  }
  // Retained counts read the same as fresh ones; a "Last known" prefix cost the row too much width.
  return `${info.totalWorktrees} worktree${info.totalWorktrees === 1 ? '' : 's'}${
    info.activeCount > 0 ? ` · ${info.activeCount} active` : ''
  }`
}
