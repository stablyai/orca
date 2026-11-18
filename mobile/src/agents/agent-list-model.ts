import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import { agentListEntryMatches } from './agent-list-row-text'
import {
  agentStatusGroup,
  asTopLevel,
  byStatusThenRecent,
  everyRow,
  hostAgents,
  listedAgentVerdict,
  newestFirst,
  rowNeedsYou,
  type AgentListInput,
  type AgentListRow,
  type AgentStatusGroup,
  type HostAgents
} from './agent-list-rows'

export const AGENT_LIST_GROUP_BY_CHOICES = [
  'status',
  'workspace',
  'project',
  'agent',
  'desktop'
] as const

export type AgentListGroupBy = (typeof AGENT_LIST_GROUP_BY_CHOICES)[number]

export type AgentListView = Readonly<{
  groupBy: AgentListGroupBy
  showWorkers: boolean
  unreadOnly: boolean
}>

export const DEFAULT_AGENT_LIST_VIEW: AgentListView = {
  groupBy: 'status',
  showWorkers: true,
  unreadOnly: false
}

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
  const urgent = (group: GroupDraft) => (group.rows.some(rowNeedsYou) ? 0 : 1)
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
): { sections: AgentListSection[]; anyLive: boolean } {
  const { view } = options
  const hosts = input.hosts
    .filter((host) => options.hostFilter === null || host.id === options.hostFilter)
    .map((host) => hostAgents(input, host.id))
  // With no desktop read this session, an empty list says nothing about running agents.
  const anyLive = hosts.some((host) => host.live)
  const nameDesktop = input.hosts.length > 1 && options.hostFilter === null
  const query = options.query.trim().toLowerCase()

  // Unread is the desktop's verdict alone. Rows it gave none stay: hiding them would claim they
  // were read. A coordinator stays for its unread worker.
  const shown = (row: AgentListRow) =>
    !view.unreadOnly ||
    row.unread === true ||
    (row.unread === undefined && !listedAgentVerdict(row.entry.agent)) ||
    row.workers.some((worker) => worker.unread)
  const topLevel = (host: HostAgents): AgentListRow[] => {
    if (query) {
      // A match is shown on its own; its coordinator may not match.
      return everyRow(host.roots)
        .filter((row) => agentListEntryMatches(row.entry, query))
        .map(asTopLevel)
        .filter(shown)
    }
    if (!view.showWorkers) {
      // Desktop hides a finished worker and lists a live one on its own; without its verdict, only
      // a worker that needs the user shows.
      return everyRow(host.roots)
        .filter((row) => {
          const verdict = listedAgentVerdict(row.entry.agent)
          return verdict ? !verdict.foldedChild : row.depth === 0 || rowNeedsYou(row)
        })
        .map(asTopLevel)
        .filter(shown)
    }
    // A worker that needs the user can't hide inside a folded coordinator.
    const surfaced = host.roots.flatMap((root) => root.workers.filter(rowNeedsYou).map(asTopLevel))
    return [...host.roots, ...surfaced].filter(shown)
  }

  const section = (
    draft: GroupDraft,
    kind: AgentListSectionKind,
    footer: AgentListSection['footer'],
    names: boolean,
    order = newestFirst
  ): AgentListSection => ({
    ...draft,
    kind,
    rows: [...draft.rows].sort(order),
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
    return { sections, anyLive }
  }

  if (view.groupBy === 'status') {
    const live = hosts.filter((host) => host.live).flatMap(topLevel)
    const sections: AgentListSection[] = STATUS_SECTIONS.map((kind) =>
      section(
        { key: kind, rows: live.filter((row) => agentStatusGroup(row.dotState) === kind) },
        kind,
        'workspace',
        nameDesktop,
        byStatusThenRecent
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
    return { sections, anyLive }
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
  return { sections, anyLive }
}

/** Every row the list holds, folded ones included, once each: what "Mark all read" and "Clear finished" act on. */
export function agentListRowsIn(sections: readonly AgentListSection[]): AgentListRow[] {
  const rows = new Map<string, AgentListRow>()
  for (const section of sections) {
    for (const row of everyRow([...section.rows, ...(section.idleRows ?? [])])) {
      rows.set(row.key, row)
    }
  }
  return [...rows.values()]
}
