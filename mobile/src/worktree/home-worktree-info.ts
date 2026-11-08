import type { AgentWorkingMode } from '../../../src/shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

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

/** One agent on a desktop, with the workspace it runs in. */
export type HomeAgentEntry = Readonly<{
  worktreeId: string
  workspaceName: string
  repo: string
  branch: string
  agent: RuntimeWorktreeAgentRow
}>

export type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: HomeWorktreeSummary | null
  /** Every agent from this connection's latest list read. */
  agents?: HomeAgentEntry[]
  /** The agents of a read the connection has since lost: what they were, not what they are. */
  lastSeenAgents?: HomeAgentEntry[]
  catalogUnavailable?: boolean
  // The counts are the last proven ones, kept across a failed refresh.
  staleCounts?: boolean
  // Epoch ms of the last proven counts.
  countsProvenAt?: number
}

export function homeAgentEntries(worktrees: readonly HomeWorktreeSummary[]): HomeAgentEntry[] {
  return worktrees.flatMap((worktree) =>
    Array.isArray(worktree.agents)
      ? worktree.agents.map((agent) => ({
          worktreeId: worktree.worktreeId,
          workspaceName: worktree.displayName || worktree.repo,
          repo: worktree.repo,
          branch: worktree.branch,
          agent
        }))
      : []
  )
}

/** Agent states are live facts; a saved copy can't vouch for them, even as last seen. */
export function withoutHomeAgentStates(info: HostWorktreeInfo): HostWorktreeInfo {
  if (!info.agents && !info.lastSeenAgents) {
    return info
  }
  const { agents: _agents, lastSeenAgents: _lastSeenAgents, ...rest } = info
  return rest
}

/** A dropped connection keeps its agents only as last seen; the reconnect read makes them live again. */
export function withLastSeenHomeAgents(info: HostWorktreeInfo): HostWorktreeInfo {
  if (!info.agents) {
    return info
  }
  const { agents, ...rest } = info
  return { ...rest, lastSeenAgents: agents }
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
