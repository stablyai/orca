import type { AgentWorkingMode } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'

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
  /** Set when the agent is a bot's chat in its home: the row names and pictures the bot. */
  bot?: HomeAgentBot
}>

export type HomeAgentBot = Readonly<{ name: string; avatar: string | null }>

export type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  /** Every agent from this connection's latest list read. */
  agents?: readonly HomeAgentEntry[]
  /** This connection's unread rows, by worktree id. */
  unreadWorktreeIds?: readonly string[]
  /** The agents of a read the connection has since lost: what they were, not what they are. */
  lastSeenAgents?: readonly HomeAgentEntry[]
  catalogUnavailable?: boolean
  // The counts are the last proven ones, kept across a failed refresh.
  staleCounts?: boolean
  // Epoch ms of the last proven counts.
  countsProvenAt?: number
}

export function homeAgentEntries(
  worktrees: readonly HomeWorktreeSummary[],
  botByHomeId: ReadonlyMap<string, HomeAgentBot> = new Map()
): HomeAgentEntry[] {
  return worktrees.flatMap((worktree) => {
    if (!Array.isArray(worktree.agents)) {
      return []
    }
    const bot = botByHomeId.get(worktree.worktreeId)
    return worktree.agents.map((agent) => ({
      worktreeId: worktree.worktreeId,
      workspaceName: bot?.name || worktree.displayName || worktree.repo,
      repo: worktree.repo,
      branch: worktree.branch,
      agent,
      ...(bot ? { bot } : {})
    }))
  })
}

/** One desktop's counts read, as its card and the Agents list see it. */
export type HomeWorktreeRead = {
  data:
    | {
        totalWorktrees: number
        activeCount: number
        agents: readonly HomeAgentEntry[]
        unreadWorktreeIds?: readonly string[]
      }
    | undefined
  dataUpdatedAt: number
  // The latest read failed; counts it had stay, as stale ones.
  failed: boolean
}

/**
 * A card's worktree info, or undefined while nothing is known. Agents read on this connection are live;
 * older ones, from a lost connection or an earlier launch's store (which keeps none), are only last seen.
 */
export function homeWorktreeInfo(
  hostId: string,
  read: HomeWorktreeRead,
  isLive: (hostId: string, readAt: number) => boolean
): HostWorktreeInfo | undefined {
  const { data, failed } = read
  if (!data) {
    // Never claim a count the host has not proven (STA-3123).
    return failed
      ? { hostId, totalWorktrees: 0, activeCount: 0, catalogUnavailable: true }
      : undefined
  }
  const live = isLive(hostId, read.dataUpdatedAt)
  const agents = data.agents.length > 0 ? data.agents : undefined
  return {
    hostId,
    totalWorktrees: data.totalWorktrees,
    activeCount: data.activeCount,
    ...(live ? { agents: data.agents } : agents ? { lastSeenAgents: agents } : {}),
    ...(live && data.unreadWorktreeIds ? { unreadWorktreeIds: data.unreadWorktreeIds } : {}),
    ...(failed ? { catalogUnavailable: true, staleCounts: true } : {}),
    countsProvenAt: read.dataUpdatedAt
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
