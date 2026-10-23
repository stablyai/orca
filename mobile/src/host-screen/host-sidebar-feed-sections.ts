import {
  LOCAL_EXECUTION_HOST_ID,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../src/shared/folder-workspace-worktree'
import { getFolderWorkspaceHostId } from '../../../src/shared/sidebar-list/folder-workspace-host-id'
import type { HostSectionRow } from '../../../src/shared/sidebar-list/host-section-rows'
import type { GroupHeaderRow } from '../../../src/shared/sidebar-list/row-types'
import { PR_GROUP_LABELS } from '../../../src/shared/workspace-view/workspace-pr-groups'
import type { Worktree as HostWorktree } from '../../../src/shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
import type { Section, Worktree } from '../worktree/workspace-list-types'
import {
  isLastVisitedWorktreeRow,
  type LastVisitedWorktreeOnHost
} from '../worktree/host-list-highlight'
import { resolveWorktreeHostId } from '../worktree/worktree-host-context-labels'
import { filterWorktrees } from '../worktree/workspace-list-sections'
import { rowFiltersForView, type MobileViewState } from '../worktree/workspace-view-settings'

/** What the host screen draws from a feed-built list, besides its rows' own live content. */
export type HostFeedListSources = {
  rows: readonly HostSectionRow[]
  /** The phone's own highlight; null while unread or never opened, when nothing is lit. */
  lastVisited: LastVisitedWorktreeOnHost | null
  /** The rows worktree.ps and the desktop's server lists served, for what each row draws. */
  liveRows: readonly Worktree[]
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  search: string
}

/** The builder names data headers; Pinned, All and the PR lanes each client names itself. */
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

/** Only worktree.ps carries these; a row it has not listed yet draws without them. */
const NO_LIVE_CONTENT = { liveTerminalCount: 0, hasAttachedPty: false, linkedPR: null }

/** What the feed carries comes from the feed: an older worktree.ps row adds only what it lacks. */
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

/**
 * The phone's sections from the list the shared builder made from the feed: the desktop's headers,
 * order and nesting, each row drawn with the live content the phone already reads, and highlighted
 * by `isLastVisitedWorktreeRow`.
 * Search narrows the rows here, as the desktop's own search never reaches the feed.
 */
export function buildHostFeedSections(sources: HostFeedListSources): Section[] {
  const liveRowOf = indexLiveRows(sources.liveRows, sources.repoHostIdByRepoId)
  const query = sources.search.trim().toLowerCase()
  const sections: Section[] = []
  let sectionHostId: ExecutionHostId | null = null
  const rowOf = (
    worktree: HostWorktree,
    hostId: ExecutionHostId,
    repoName: string | undefined,
    workspaceKind: Worktree['workspaceKind']
  ): Worktree => {
    const drawn = drawnRow(
      worktree,
      hostId,
      repoName,
      workspaceKind,
      liveRowOf(worktree.id, hostId)
    )
    return hostId === sectionHostId ? { ...drawn, hostContextLabel: undefined } : drawn
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
          key: row.collapseKey ?? row.key,
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
        const drawn = rowOf(row.worktree, hostId, row.repo?.displayName, 'git')
        current().data.push({
          ...drawn,
          isActive: isLastVisitedWorktreeRow(
            { worktreeId: row.worktree.id, hostId },
            sources.lastVisited
          ),
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
            (drawn.hostContextHealthLabel ? drawn.hostContextLabel : undefined)
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
        current().data.push({
          ...rowOf(worktree, hostId, row.projectGroup.name, 'folder-workspace'),
          isActive: isLastVisitedWorktreeRow(
            { worktreeId: worktree.id, hostId },
            sources.lastVisited
          ),
          sectionListKey: row.key,
          lineageDepth: 0,
          ...(row.groupDepth ? { projectGroupDepth: row.groupDepth } : {}),
          ...(row.projectGroup.createdFrom === 'folder-scan' ? { inFolderScanGroup: true } : {})
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

/**
 * For a host whose feed this page cannot read: the rows worktree.ps listed under the view's
 * filters, in their served order and no header, so an older desktop still gets a list.
 */
export function buildPreFeedSections(sources: {
  rows: Worktree[]
  view: MobileViewState
  search: string
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  lastVisited: LastVisitedWorktreeOnHost | null
}): Section[] {
  const rows = filterWorktrees(
    sources.rows,
    rowFiltersForView(sources.view),
    sources.search,
    sources.repoHostIdByRepoId
  ).map((row) => ({
    ...row,
    // Replaces worktree.ps's mark, which is the desktop's selection.
    isActive: isLastVisitedWorktreeRow(row, sources.lastVisited)
  }))
  return rows.length > 0 ? [{ key: 'all', title: '', data: rows }] : []
}

/** A section whose title matches keeps every row; otherwise only matching rows, counted as shown. */
function narrowSections(sections: readonly Section[], query: string): Section[] {
  return sections.flatMap((section) => {
    if (section.title.toLowerCase().includes(query)) {
      return [section]
    }
    const data = section.data.filter((row) => matchesSearch(row, query))
    // Only matching rows: a creation has no name to match yet.
    return data.length > 0
      ? [{ ...section, data, count: data.length, pendingCreations: undefined }]
      : []
  })
}
