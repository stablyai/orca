import {
  AGENT_LIST_STATUS_RANK,
  type AgentListVerdict
} from '../../../src/shared/agent-status/presentation/agent-list-status'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { ConnectionState } from '../transport/connection/connection-state'
import { agentDotState, agentRowTimeAt, type AgentDotState } from '../worktree/agent-row-display'
import { flattenAgentRowLineage, type AgentRowNode } from '../worktree/agent-row-lineage'
import type { HomeAgentEntry, HostWorktreeInfo } from '../worktree/home-worktree-info'
import { agentListTitle } from './agent-list-row-text'

export type AgentStatusGroup = 'needs-you' | 'working' | 'done' | 'idle'

/** Desktop's status ranks cut into sections: everything ranked above live work needs the user. */
export function agentStatusGroup(state: AgentDotState): AgentStatusGroup {
  const rank = AGENT_LIST_STATUS_RANK[state]
  if (rank < AGENT_LIST_STATUS_RANK.working) {
    return 'needs-you'
  }
  if (rank <= AGENT_LIST_STATUS_RANK.monitoring) {
    return 'working'
  }
  return state === 'idle' ? 'idle' : 'done'
}

export type ListedAgentVerdict = Extract<AgentListVerdict, { listed: true }>

/** The desktop Agents list's row for this agent; undefined when the host sent no verdict. */
export function listedAgentVerdict(agent: RuntimeWorktreeAgentRow): ListedAgentVerdict | undefined {
  return agent.activity?.listed === true ? agent.activity : undefined
}

export type AgentListRow = Readonly<{
  key: string
  hostId: string
  entry: HomeAgentEntry
  title: string
  dotState: AgentDotState
  timeAt: number
  /** A copy from a read the desktop no longer backs: it claims no state. */
  stale: boolean
  /** Its desktop isn't connected, so the row can't open. */
  offline: boolean
  /** The desktop's read verdict; undefined when it gave none, so the phone claims nothing. */
  unread?: boolean
  /** A finished turn the desktop can clear from its Agents list. */
  clearable: boolean
  depth: number
  /** Nested workers in tree order; empty when workers are hidden. */
  workers: readonly AgentListRow[]
}>

export type AgentListInput = Readonly<{
  /** Paired desktops in Home's order. */
  hosts: readonly { id: string }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
  now: number
  /** Writes sent but not yet read back, by row key. */
  pendingActivity?: Readonly<Record<string, AgentActivityChange>>
}>

/** A read or clear the phone asked its desktop for. */
export type AgentActivityChange = Readonly<{ unread: boolean } | { cleared: true }>

export function agentListRowKey(hostId: string, paneKey: string): string {
  return `${hostId}:${paneKey}`
}

export type HostAgents = {
  hostId: string
  roots: AgentListRow[]
  live: boolean
  offline: boolean
  seenAt?: number
}

export function hostAgents(input: AgentListInput, hostId: string): HostAgents {
  const info = input.worktreeInfo[hostId]
  const connected = input.hostStates[hostId] === 'connected'
  // Only this connection's own read may show states; anything else is what the agents last were.
  const liveAgents = connected && !info?.catalogUnavailable ? info?.agents : undefined
  const live = liveAgents !== undefined
  const pending = (paneKey: string) => input.pendingActivity?.[agentListRowKey(hostId, paneKey)]
  // Only what the desktop lists, less what the phone just cleared; a cleared agent's workers stay, as roots.
  const entries = (liveAgents ?? info?.lastSeenAgents ?? info?.agents ?? []).filter((entry) => {
    const change = pending(entry.agent.paneKey)
    return entry.agent.activity?.listed !== false && !(change && 'cleared' in change)
  })
  const entryByPaneKey = new Map(entries.map((entry) => [entry.agent.paneKey, entry]))
  const toRow = (node: AgentRowNode, depth: number): AgentListRow | null => {
    const entry = entryByPaneKey.get(node.row.paneKey)
    if (!entry) {
      return null
    }
    const { agent } = entry
    const verdict = listedAgentVerdict(agent)
    const liveVerdict = live ? verdict : undefined
    const change = pending(agent.paneKey)
    return {
      key: agentListRowKey(hostId, agent.paneKey),
      hostId,
      entry,
      title: verdict?.title.trim() || agentListTitle(agent),
      dotState: !live ? 'idle' : verdict ? verdict.status : agentDotState(agent, input.now),
      timeAt: verdict?.sortAt ?? agentRowTimeAt(agent),
      stale: !live,
      offline: !connected,
      // Read state is the desktop's call; a host that sends none gets no bell and no actions.
      unread: liveVerdict
        ? change && 'unread' in change
          ? change.unread
          : liveVerdict.unread
        : undefined,
      clearable: liveVerdict?.clearable === true,
      depth,
      workers: node.children.flatMap((child) => descendants(child, depth + 1))
    }
  }
  const descendants = (node: AgentRowNode, depth: number): AgentListRow[] => {
    const row = toRow(node, depth)
    return row ? [{ ...row, workers: [] }, ...row.workers] : []
  }
  // Lineage spans the desktop: a coordinator's workers often run in other workspaces. Desktop's
  // own nesting wins where it gave a verdict.
  const lineage = entries.map(({ agent }) => {
    const verdict = listedAgentVerdict(agent)
    return verdict ? { ...agent, parentPaneKey: verdict.childOf ?? null } : agent
  })
  const roots = flattenAgentRowLineage(lineage)
    .filter((node) => node.depth === 0)
    .map((node) => toRow(node, 0))
    .filter((row): row is AgentListRow => row !== null)
  return { hostId, roots, live, offline: !connected, seenAt: info?.countsProvenAt }
}

export function everyRow(roots: readonly AgentListRow[]): AgentListRow[] {
  return roots.flatMap((row) => [row, ...row.workers])
}

export const asTopLevel = (row: AgentListRow): AgentListRow => ({ ...row, depth: 0, workers: [] })

export const newestFirst = (a: AgentListRow, b: AgentListRow): number => b.timeAt - a.timeAt

/** Desktop's status order, newest first within a status. */
export const byStatusThenRecent = (a: AgentListRow, b: AgentListRow): number =>
  AGENT_LIST_STATUS_RANK[a.dotState] - AGENT_LIST_STATUS_RANK[b.dotState] || newestFirst(a, b)

export function rowNeedsYou(row: AgentListRow): boolean {
  return !row.stale && agentStatusGroup(row.dotState) === 'needs-you'
}

/** Live agents that need the user, workers included: Feed's rows and both badge counts. */
export function selectAgentsNeedingYou(input: AgentListInput): AgentListRow[] {
  return input.hosts
    .flatMap((host) => everyRow(hostAgents(input, host.id).roots))
    .filter(rowNeedsYou)
    .map(asTopLevel)
    .sort(byStatusThenRecent)
}

/** Live agents that need the user or are working, workers included: Feed's Active rows. */
export function selectActiveAgents(input: AgentListInput): AgentListRow[] {
  return input.hosts
    .flatMap((host) => everyRow(hostAgents(input, host.id).roots))
    .filter((row) => {
      const group = agentStatusGroup(row.dotState)
      return !row.stale && (group === 'needs-you' || group === 'working')
    })
    .map(asTopLevel)
    .sort(byStatusThenRecent)
}

export function countAgentsNeedingYouByHost(
  rows: readonly AgentListRow[]
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[row.hostId] = (counts[row.hostId] ?? 0) + 1
  }
  return counts
}

export type AgentListHostSummary = Readonly<{
  hostId: string
  agents: number
  needsYou: number
  offline: boolean
}>

export function summarizeAgentListHosts(input: AgentListInput): AgentListHostSummary[] {
  return input.hosts.map((host) => {
    const agents = hostAgents(input, host.id)
    const rows = everyRow(agents.roots)
    return {
      hostId: host.id,
      agents: rows.length,
      needsYou: rows.filter(rowNeedsYou).length,
      offline: agents.offline
    }
  })
}
