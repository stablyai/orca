import {
  LOCAL_EXECUTION_HOST_ID,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../src/shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../src/shared/folder-workspaces/folder-workspace-worktree'
import { getFolderWorkspaceHostId } from '../../../../src/shared/sidebar-list/hosts/folder-workspace-host-id'
import type { HostSectionRow } from '../../../../src/shared/sidebar-list/hosts/host-section-rows'
import type { GroupHeaderRow } from '../../../../src/shared/sidebar-list/row-types'
import { PR_GROUP_LABELS } from '../../../../src/shared/workspace-view/workspace-pr-groups'
import type { Worktree as HostWorktree } from '../../../../src/shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../src/shared/worktree/host-qualified-identity'
import type {
  Section,
  Worktree,
  WorktreeHostContextView
} from '../../worktree/workspace-list-types'
import {
  isLastVisitedWorktreeRow,
  type LastVisitedWorktreeOnHost
} from '../../worktree/host-list-highlight'
import {
  resolveWorktreeHostId,
  type WorktreeHostContextOf
} from '../../worktree/worktree-host-context-labels'
import '../../worktree/workspace-list-sections'
import { filterWorktrees } from '../../worktree/workspace-row-filtering'
import { rowFiltersForView, type MobileViewState } from '../../worktree/workspace-view-settings'
import type { HiddenProjects } from '../../../../src/shared/hidden-projects'

export type HostFeedListSources = {
  rows: readonly HostSectionRow[]
  /** The phone's own highlight; null while unread or never opened, when nothing is lit. */
  lastVisited: LastVisitedWorktreeOnHost | null
  liveRows: readonly Worktree[]
  hostContextOf: WorktreeHostContextOf
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  search: string
}

// Clients name Pinned/All/PR lanes themselves; the builder names data headers.
function headerTitle(row: GroupHeaderRow): string {
  switch (row.icon.kind) {
    case 'pinned':
      return row.label ?? 'Pinned'
    case 'all':
      return row.label ?? 'All'
    case 'pr-status':
      return row.label ?? PR_GROUP_LABELS[row.icon.prGroup]
    case 'project':
    case 'workspace-status':
      return row.label ?? ''
  }
}

function indexLiveRows(
  rows: readonly Worktree[],
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): (id: string, hostId: ExecutionHostId) => Worktree | undefined {
  const byIdentity = new Map<string, Worktree>()
  for (const row of rows) {
    const identity = composeWorktreeHostIdentity(
      resolveWorktreeHostId(row, repoHostIdByRepoId),
      row.worktreeId
    )
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, row)
    }
  }
  // The same id can live on two hosts; only the row's own host's copy draws it.
  return (id, hostId) => byIdentity.get(composeWorktreeHostIdentity(hostId, id))
}

const NO_LIVE_CONTENT = { liveTerminalCount: 0, hasAttachedPty: false, linkedPR: null }

// Feed fields win; older worktree.ps rows supply only missing live content.
function drawnRow(
  worktree: HostWorktree,
  hostId: ExecutionHostId,
  repoName: string | undefined,
  workspaceKind: Worktree['workspaceKind'],
  live: Worktree | undefined
): Worktree {
  return {
    ...(live ?? NO_LIVE_CONTENT),
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    hostId,
    workspaceKind,
    repo: repoName ?? live?.repo ?? '',
    branch: worktree.branch,
    displayName: worktree.displayName,
    comment: worktree.comment,
    path: worktree.path,
    isArchived: worktree.isArchived,
    isMainWorktree: worktree.isMainWorktree,
    unread: worktree.isUnread,
    isPinned: worktree.isPinned
  }
}

function matchesSearch(row: Worktree, query: string): boolean {
  return (
    row.displayName.toLowerCase().includes(query) ||
    row.branch.toLowerCase().includes(query) ||
    row.repo.toLowerCase().includes(query)
  )
}

// Use desktop headers/order/nesting with phone live content and last-visited highlight; apply search locally because desktop search never reaches the feed.
// Project and group headers repeat per host section but collapse as one.
function hostSectionKeys(
  collapseKey: string,
  sectionHostId: ExecutionHostId | null
): Pick<Section, 'key' | 'collapseKey'> {
  return sectionHostId
    ? { key: `${collapseKey}@${sectionHostId}`, collapseKey }
    : { key: collapseKey }
}

export function buildHostFeedSections(sources: HostFeedListSources): Section[] {
  const liveRowOf = indexLiveRows(sources.liveRows, sources.repoHostIdByRepoId)
  const query = sources.search.trim().toLowerCase()
  const sections: Section[] = []
  let sectionHostId: ExecutionHostId | null = null
  const itemOf = (
    worktree: HostWorktree,
    hostId: ExecutionHostId,
    repoName: string | undefined,
    workspaceKind: Worktree['workspaceKind']
  ): { row: Worktree; hostContext: WorktreeHostContextView } => {
    const live = liveRowOf(worktree.id, hostId)
    const hostContext = (live && sources.hostContextOf(live)) ?? {}
    return {
      row: drawnRow(worktree, hostId, repoName, workspaceKind, live),
      hostContext:
        hostId === sectionHostId ? { ...hostContext, hostContextLabel: undefined } : hostContext
    }
  }
  const push = (section: Section) => sections.push(section)
  const current = (): Section => {
    const last = sections.at(-1)
    if (last) {
      return last
    }
    const first: Section = { key: 'all', title: '', data: [] }
    push(first)
    return first
  }

  // Why: the desktop steps folder-scanned groups' rows by the compact header step; a group's header precedes its rows.
  const folderScanGroupIds = new Set<string>()
  for (const row of sources.rows) {
    switch (row.type) {
      case 'host-header':
        sectionHostId = row.hostId
        push({ key: row.key, title: row.label, count: row.count, data: [] })
        break
      case 'header':
        if (
          row.projectGroup?.id &&
          'createdFrom' in row.projectGroup &&
          row.projectGroup.createdFrom === 'folder-scan'
        ) {
          folderScanGroupIds.add(row.projectGroup.id)
        }
        push({
          ...hostSectionKeys(row.collapseKey ?? row.key, sectionHostId),
          title: headerTitle(row),
          count: row.count,
          ...(row.icon.kind === 'pinned' ? { icon: 'pin' as const } : {}),
          ...(row.repo ? { repo: row.repo } : {}),
          ...(row.projectGroup && !row.repo ? { isProjectGroup: true } : {}),
          ...(row.projectGroupDepth ? { projectGroupDepth: row.projectGroupDepth } : {}),
          data: []
        })
        break
      case 'item': {
        // Local as the fallback, as the phone resolves its own rows: the desktop's focus is not an owner.
        const hostId = getWorktreeExecutionHostId(row.worktree, row.repo, LOCAL_EXECUTION_HOST_ID)
        const { row: drawn, hostContext } = itemOf(
          row.worktree,
          hostId,
          row.repo?.displayName,
          'git'
        )
        current().data.push({
          row: {
            ...drawn,
            isActive: isLastVisitedWorktreeRow(
              { worktreeId: row.worktree.id, hostId },
              sources.lastVisited
            )
          },
          view: {
            ...hostContext,
            sectionListKey: row.rowKey,
            lineageDepth: row.depth,
            ...(row.groupDepth ? { projectGroupDepth: row.groupDepth } : {}),
            ...(row.repo?.projectGroupId && folderScanGroupIds.has(row.repo.projectGroupId)
              ? { inFolderScanGroup: true }
              : {}),
            lineageChildCount: row.lineageChildCount,
            lineageCollapsed: row.lineageCollapsed === true,
            isLastLineageChild: row.isLastLineageChild,
            ...(row.lineageGroupKey ? { lineageGroupKey: row.lineageGroupKey } : {}),
            showProjectName: row.showProjectName === true,
            // The desktop's mixed-host rule names the host; a health word alone still shows.
            hostContextLabel:
              row.hostContextLabel ??
              (hostContext.hostContextHealthLabel ? hostContext.hostContextLabel : undefined)
          }
        })
        break
      }
      case 'folder-workspace': {
        const worktree = folderWorkspaceToWorktree(row.folderWorkspace)
        const hostId = getFolderWorkspaceHostId(
          row.folderWorkspace,
          row.projectGroup,
          LOCAL_EXECUTION_HOST_ID
        )
        const { row: drawn, hostContext } = itemOf(
          worktree,
          hostId,
          row.projectGroup.name,
          'folder-workspace'
        )
        current().data.push({
          row: {
            ...drawn,
            isActive: isLastVisitedWorktreeRow(
              { worktreeId: worktree.id, hostId },
              sources.lastVisited
            )
          },
          view: {
            ...hostContext,
            sectionListKey: row.key,
            lineageDepth: row.depth,
            ...(row.groupDepth ? { projectGroupDepth: row.groupDepth } : {}),
            ...(row.projectGroup.createdFrom === 'folder-scan' ? { inFolderScanGroup: true } : {}),
            lineageChildCount: row.lineageChildCount ?? 0,
            lineageCollapsed: row.lineageCollapsed === true,
            ...(row.lineageGroupKey ? { lineageGroupKey: row.lineageGroupKey } : {})
          }
        })
        break
      }
      case 'pending-creation': {
        const section = current()
        section.pendingCreations ??= []
        section.pendingCreations.push({
          key: row.key,
          // A project header already names it.
          repoName:
            section.repo && section.repo.id === row.repo?.id
              ? null
              : (row.repo?.displayName ?? null)
        })
        break
      }
      // The desktop-only cards draw nothing on the phone.
      case 'imported-worktrees-card':
      case 'new-external-worktrees-inbox':
        break
    }
  }
  return query ? narrowSections(sections, query) : sections
}

// Older hosts with unreadable feeds still list filtered worktree.ps rows in served order without headers.
export function buildPreFeedSections(sources: {
  rows: Worktree[]
  hostContextOf: WorktreeHostContextOf
  view: MobileViewState
  search: string
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  lastVisited: LastVisitedWorktreeOnHost | null
  /** The catalog's hidden projects; this fallback leaves them out as the feed's rows do. */
  hiddenProjects: HiddenProjects
}): Section[] {
  const rows = filterWorktrees(
    sources.rows,
    rowFiltersForView(sources.view),
    sources.search,
    sources.repoHostIdByRepoId,
    sources.hiddenProjects
  ).map((row) => ({
    // Replaces worktree.ps's mark, which is the desktop's selection.
    row: { ...row, isActive: isLastVisitedWorktreeRow(row, sources.lastVisited) },
    view: { ...sources.hostContextOf(row) }
  }))
  return rows.length > 0 ? [{ key: 'all', title: '', data: rows }] : []
}

function narrowSections(sections: readonly Section[], query: string): Section[] {
  return sections.flatMap((section) => {
    if (section.title.toLowerCase().includes(query)) {
      return [section]
    }
    const data = section.data.filter((item) => matchesSearch(item.row, query))
    // Only matching rows: a creation has no name to match yet.
    return data.length > 0
      ? [{ ...section, data, count: data.length, pendingCreations: undefined }]
      : []
  })
}
