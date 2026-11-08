import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { ConnectionState } from '../transport/connection/connection-state'
import { agentDotState, agentRowTimeAt, type AgentDotState } from '../worktree/agent-row-display'
import { flattenAgentRowLineage, type AgentRowNode } from '../worktree/agent-row-lineage'
import type { HomeAgentEntry, HostWorktreeInfo } from '../worktree/home-worktree-info'
import { agentListEntryMatches } from './agent-list-row-text'

export const AGENT_LIST_GROUP_BY_CHOICES = [
  'status',
  'workspace',
  'project',
  'agent',
  'desktop'
] as const

export type AgentListGroupBy = (typeof AGENT_LIST_GROUP_BY_CHOICES)[number]

export type AgentListView = Readonly<{ groupBy: AgentListGroupBy; showWorkers: boolean }>

export const DEFAULT_AGENT_LIST_VIEW: AgentListView = { groupBy: 'status', showWorkers: true }

export type AgentStatusGroup = 'needs-you' | 'working' | 'done' | 'idle'

export function agentStatusGroup(state: AgentDotState): AgentStatusGroup {
  switch (state) {
    case 'blocked':
    case 'waiting':
    case 'failed':
      return 'needs-you'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
    case 'interrupted':
    case 'unconfirmed':
      return 'done'
    case 'idle':
    case 'unverifiable':
      return 'idle'
  }
}

export type AgentListRow = Readonly<{
  key: string
  hostId: string
  entry: HomeAgentEntry
  dotState: AgentDotState
  timeAt: number
  /** A copy from a read the desktop no longer backs: it claims no state. */
  stale: boolean
  /** Its desktop isn't connected, so the row can't open. */
  offline: boolean
  depth: number
  /** Nested workers in tree order; empty when workers are hidden. */
  workers: readonly AgentListRow[]
}>

export type AgentListSectionKind = AgentStatusGroup | 'workspace' | 'project' | 'agent' | 'desktop'

export type AgentListSection = Readonly<{
  key: string
  kind: AgentListSectionKind
  /** The workspace, project or agent a data-named section is for. */
  title?: string
  hostId?: string
  rows: readonly AgentListRow[]
  /** Status grouping folds idle agents into one row at the end of the list. */
  idleRows?: readonly AgentListRow[]
  /** A desktop whose rows are last seen, and when they were read. */
  lastSeen?: Readonly<{ offline: boolean; at?: number }>
  /** What each row's footer names; the section header names the rest. */
  footer: 'workspace' | 'agent'
  nameDesktop: boolean
}>

export type AgentListInput = Readonly<{
  /** Paired desktops in Home's order. */
  hosts: readonly { id: string }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
  now: number
}>

type HostAgents = {
  hostId: string
  roots: AgentListRow[]
  live: boolean
  offline: boolean
  seenAt?: number
}

function hostAgents(input: AgentListInput, hostId: string): HostAgents {
  const info = input.worktreeInfo[hostId]
  const connected = input.hostStates[hostId] === 'connected'
  // Only this connection's own read may show states; anything else is what the agents last were.
  const liveAgents = connected && !info?.catalogUnavailable ? info?.agents : undefined
  const live = liveAgents !== undefined
  const entries = liveAgents ?? info?.lastSeenAgents ?? info?.agents ?? []
  const entryByAgent = new Map<RuntimeWorktreeAgentRow, HomeAgentEntry>(
    entries.map((entry) => [entry.agent, entry])
  )
  const toRow = (node: AgentRowNode, depth: number): AgentListRow | null => {
    const entry = entryByAgent.get(node.row)
    if (!entry) {
      return null
    }
    return {
      key: `${hostId}:${node.row.paneKey}`,
      hostId,
      entry,
      dotState: live ? agentDotState(node.row, input.now) : 'idle',
      timeAt: agentRowTimeAt(node.row),
      stale: !live,
      offline: !connected,
      depth,
      workers: node.children.flatMap((child) => descendants(child, depth + 1))
    }
  }
  const descendants = (node: AgentRowNode, depth: number): AgentListRow[] => {
    const row = toRow(node, depth)
    return row ? [{ ...row, workers: [] }, ...row.workers] : []
  }
  // Lineage spans the desktop: a coordinator's workers often run in other workspaces.
  const roots = flattenAgentRowLineage(entries.map((entry) => entry.agent))
    .filter((node) => node.depth === 0)
    .map((node) => toRow(node, 0))
    .filter((row): row is AgentListRow => row !== null)
  return { hostId, roots, live, offline: !connected, seenAt: info?.countsProvenAt }
}

function everyRow(roots: readonly AgentListRow[]): AgentListRow[] {
  return roots.flatMap((row) => [row, ...row.workers])
}

const asTopLevel = (row: AgentListRow): AgentListRow => ({ ...row, depth: 0, workers: [] })

const newestFirst = (a: AgentListRow, b: AgentListRow): number => b.timeAt - a.timeAt

function needsYou(row: AgentListRow): boolean {
  return !row.stale && agentStatusGroup(row.dotState) === 'needs-you'
}

/** Live agents that need the user, workers included: Feed's rows and both badge counts. */
export function selectAgentsNeedingYou(input: AgentListInput): AgentListRow[] {
  return input.hosts
    .flatMap((host) => everyRow(hostAgents(input, host.id).roots))
    .filter(needsYou)
    .map(asTopLevel)
    .sort(newestFirst)
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
      needsYou: rows.filter(needsYou).length,
      offline: agents.offline
    }
  })
}

type GroupDraft = { key: string; title?: string; hostId?: string; rows: AgentListRow[] }

function groupRows(
  rows: readonly AgentListRow[],
  keyOf: (row: AgentListRow) => Omit<GroupDraft, 'rows'>
): GroupDraft[] {
  const groups = new Map<string, GroupDraft>()
  for (const row of rows) {
    const draft = keyOf(row)
    const group = groups.get(draft.key)
    if (group) {
      group.rows.push(row)
    } else {
      groups.set(draft.key, { ...draft, rows: [row] })
    }
  }
  return [...groups.values()]
}

// Groups with something that needs the user lead, then the most recently active.
function byUrgencyThenRecent(a: GroupDraft, b: GroupDraft): number {
  const urgent = (group: GroupDraft) => (group.rows.some(needsYou) ? 0 : 1)
  const latest = (group: GroupDraft) => Math.max(...group.rows.map((row) => row.timeAt))
  return urgent(a) - urgent(b) || latest(b) - latest(a)
}

const STATUS_SECTIONS: readonly Exclude<AgentStatusGroup, 'idle'>[] = [
  'needs-you',
  'working',
  'done'
]

export function buildAgentList(
  input: AgentListInput,
  options: Readonly<{ view: AgentListView; hostFilter: string | null; query: string }>
): { sections: AgentListSection[]; total: number } {
  const { view } = options
  const hosts = input.hosts
    .filter((host) => options.hostFilter === null || host.id === options.hostFilter)
    .map((host) => hostAgents(input, host.id))
  const total = hosts.reduce((sum, host) => sum + everyRow(host.roots).length, 0)
  const nameDesktop = input.hosts.length > 1 && options.hostFilter === null
  const query = options.query.trim().toLowerCase()

  const topLevel = (host: HostAgents): AgentListRow[] => {
    if (query) {
      // A match is shown on its own; its coordinator may not match.
      return everyRow(host.roots)
        .filter((row) => agentListEntryMatches(row.entry, query))
        .map(asTopLevel)
    }
    const roots = view.showWorkers ? host.roots : host.roots.map(asTopLevel)
    // A worker that needs the user can't hide inside a folded coordinator.
    const surfaced = host.roots.flatMap((root) => root.workers.filter(needsYou).map(asTopLevel))
    return [...roots, ...surfaced]
  }

  const section = (
    draft: GroupDraft,
    kind: AgentListSectionKind,
    footer: AgentListSection['footer'],
    names: boolean
  ): AgentListSection => ({
    ...draft,
    kind,
    rows: [...draft.rows].sort(newestFirst),
    footer,
    nameDesktop: names
  })

  if (view.groupBy === 'desktop') {
    const sections = hosts.flatMap((host): AgentListSection[] => {
      const rows = topLevel(host)
      // An offline desktop keeps its header, so its absence reads as offline rather than idle.
      if (rows.length === 0 && (host.live || query)) {
        return []
      }
      return [
        {
          ...section(
            { key: host.hostId, hostId: host.hostId, rows },
            'desktop',
            'workspace',
            false
          ),
          ...(host.live ? {} : { lastSeen: { offline: host.offline, at: host.seenAt } })
        }
      ]
    })
    return { sections, total }
  }

  if (view.groupBy === 'status') {
    const live = hosts.filter((host) => host.live).flatMap(topLevel)
    const sections: AgentListSection[] = STATUS_SECTIONS.map((kind) =>
      section(
        { key: kind, rows: live.filter((row) => agentStatusGroup(row.dotState) === kind) },
        kind,
        'workspace',
        nameDesktop
      )
    ).filter((entry) => entry.rows.length > 0)
    const idleRows = live.filter((row) => agentStatusGroup(row.dotState) === 'idle')
    if (idleRows.length > 0) {
      const folded = [...idleRows].sort(newestFirst)
      const last = sections.at(-1)
      if (last) {
        sections[sections.length - 1] = { ...last, idleRows: folded }
      } else {
        sections.push({
          ...section({ key: 'idle', rows: [] }, 'idle', 'workspace', nameDesktop),
          idleRows: folded
        })
      }
    }
    // Last-seen rows claim no status, so they stay under their desktop.
    for (const host of hosts) {
      const rows = host.live ? [] : topLevel(host)
      if (rows.length > 0) {
        sections.push({
          ...section(
            { key: host.hostId, hostId: host.hostId, rows },
            'desktop',
            'workspace',
            false
          ),
          lastSeen: { offline: host.offline, at: host.seenAt }
        })
      }
    }
    return { sections, total }
  }

  const rows = hosts.flatMap(topLevel)
  const drafts =
    view.groupBy === 'workspace'
      ? groupRows(rows, (row) => ({
          key: `${row.hostId}:${row.entry.worktreeId}`,
          title: row.entry.workspaceName,
          hostId: row.hostId
        }))
      : view.groupBy === 'project'
        ? groupRows(rows, (row) => ({
            key: `${row.hostId}:${row.entry.repo}`,
            title: row.entry.repo,
            hostId: row.hostId
          }))
        : groupRows(rows, (row) => {
            const label = formatAgentTypeLabel(row.entry.agent.agentType)
            return { key: label, title: label }
          })
  const kind = view.groupBy
  const sections = drafts
    .sort(byUrgencyThenRecent)
    .map((draft) =>
      kind === 'agent'
        ? section(draft, kind, 'workspace', nameDesktop)
        : section(draft, kind, kind === 'workspace' ? 'agent' : 'workspace', false)
    )
  return { sections, total }
}
