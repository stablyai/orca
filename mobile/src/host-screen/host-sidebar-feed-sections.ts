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
import { resolveWorktreeHostId } from '../worktree/worktree-host-context-labels'
import { filterWorktrees } from '../worktree/workspace-list-sections'
import { rowFiltersForView, type MobileViewState } from '../worktree/workspace-view-settings'

/** What the host screen draws from a feed-built list, besides its rows' own live content. */
export type HostFeedListSources = {
  rows: readonly HostSectionRow[]
  activeRowKeys: ReadonlySet<string>
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

/** A row worktree.ps has not listed yet: drawn from the feed alone, with no live content. */
function feedOnlyRow(
  worktree: HostWorktree,
  hostId: ExecutionHostId,
  repoName: string,
  workspaceKind: Worktree['workspaceKind']
): Worktree {
  return {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    hostId,
    workspaceKind,
    repo: repoName,
    branch: worktree.branch,
    displayName: worktree.displayName,
    path: worktree.path,
    isArchived: worktree.isArchived,
    isMainWorktree: worktree.isMainWorktree,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: worktree.isUnread,
    isPinned: worktree.isPinned,
    linkedPR: null
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
 * order, nesting and highlight, each row drawn with the live content the phone already reads.
 * Search narrows the rows here, as the desktop's own search never reaches the feed.
 */
export function buildHostFeedSections(sources: HostFeedListSources): Section[] {
  const liveRowOf = indexLiveRows(sources.liveRows, sources.repoHostIdByRepoId)
  const query = sources.search.trim().toLowerCase()
  const sections: Section[] = []
  const rowOf = (
    worktree: HostWorktree,
    hostId: ExecutionHostId,
    repoName: string,
    workspaceKind: Worktree['workspaceKind']
  ): Worktree =>
    liveRowOf(worktree.id, hostId) ?? feedOnlyRow(worktree, hostId, repoName, workspaceKind)
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

  for (const row of sources.rows) {
    switch (row.type) {
      case 'host-header':
        push({ key: row.key, title: row.label, count: row.count, data: [] })
        break
      case 'header':
        push({
          key: row.collapseKey ?? row.key,
          title: headerTitle(row),
          count: row.count,
          ...(row.icon.kind === 'pinned' ? { icon: 'pin' as const } : {}),
          ...(row.repo ? { repo: row.repo } : {}),
          data: []
        })
        break
      case 'item': {
        // Local as the fallback, as the phone resolves its own rows: the desktop's focus is not an owner.
        const hostId = getWorktreeExecutionHostId(row.worktree, row.repo, LOCAL_EXECUTION_HOST_ID)
        const live = rowOf(row.worktree, hostId, row.repo?.displayName ?? '', 'git')
        current().data.push({
          ...live,
          isPinned: row.worktree.isPinned,
          isActive: sources.activeRowKeys.has(row.rowKey),
          sectionListKey: row.rowKey,
          lineageDepth: row.depth,
          lineageChildCount: row.lineageChildCount,
          lineageCollapsed: row.lineageCollapsed === true,
          isLastLineageChild: row.isLastLineageChild,
          ...(row.lineageGroupKey ? { lineageGroupKey: row.lineageGroupKey } : {}),
          showProjectName: row.showProjectName === true,
          // The desktop's mixed-host rule names the host; a health word alone still shows.
          hostContextLabel:
            row.hostContextLabel ??
            (live.hostContextHealthLabel ? live.hostContextLabel : undefined)
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
          isPinned: row.folderWorkspace.isPinned,
          isActive: sources.activeRowKeys.has(row.key),
          sectionListKey: row.key,
          lineageDepth: 0
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
 * Before the first feed read: the rows this page last listed (worktree.ps, or the cache the screen
 * opened with) under the view's filters, in their served order and no header, so an offline open
 * is not blank.
 */
export function buildPreFeedSections(sources: {
  rows: Worktree[]
  view: MobileViewState
  search: string
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
}): Section[] {
  const rows = filterWorktrees(
    sources.rows,
    rowFiltersForView(sources.view),
    sources.search,
    sources.repoHostIdByRepoId
  )
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
