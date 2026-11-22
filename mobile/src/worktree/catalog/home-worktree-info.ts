import type { AgentWorkingMode } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { ServerWorkspaces } from '../execution-hosts/server-workspaces'

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
  /** Set when the agent runs on a server the desktop relays to, not on the desktop itself. */
  executionHost?: Readonly<{ id: ExecutionHostId; label: string }>
}>

export type HomeAgentBot = Readonly<{ id: string; name: string; avatar: string | null }>

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
  worktrees: readonly Pick<
    HomeWorktreeSummary,
    'worktreeId' | 'displayName' | 'repo' | 'branch' | 'agents'
  >[],
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

/** A desktop's relayed servers as Home read them, with its own identity so a server paired directly lists once. */
export type HomeServerAgentsRead = {
  installationId?: string
  servers: ServerWorkspaces
}

/**
 * Adds each relayed server's agents to its desktop's live ones, labelled with the server. A server paired
 * directly lists only there; one several desktops relay lists under the first in Home's order.
 */
export function withRelayedServerAgents(
  hostIds: readonly string[],
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>,
  reads: Readonly<Record<string, HomeServerAgentsRead>>
): Readonly<Record<string, HostWorktreeInfo>> {
  const listed = new Set(hostIds.flatMap((hostId) => reads[hostId]?.installationId ?? []))
  let merged: Record<string, HostWorktreeInfo> | null = null
  for (const hostId of hostIds) {
    const info = worktreeInfo[hostId]
    const servers = reads[hostId]?.servers
    if (!info?.agents || !servers) {
      continue
    }
    const relayed = servers.hosts.flatMap((server) => {
      if (server.installationId) {
        if (listed.has(server.installationId)) {
          return []
        }
        listed.add(server.installationId)
      }
      const executionHost = { id: server.hostId, label: server.label }
      const rows = servers.worktrees.filter(
        (row) => row.hostId === server.hostId && row.isArchived !== true
      )
      return homeAgentEntries(rows).map((entry) => ({ ...entry, executionHost }))
    })
    if (relayed.length > 0) {
      merged ??= { ...worktreeInfo }
      merged[hostId] = { ...info, agents: [...info.agents, ...relayed] }
    }
  }
  return merged ?? worktreeInfo
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
