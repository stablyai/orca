import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import {
  isListedByFolderWorkspace,
  NO_HIDDEN_PROJECTS,
  type HiddenProjects
} from '../../../../src/shared/project/catalog/hidden-projects'
import {
  filterWorkspaceRows,
  partitionWorkspaceRowsByFilters,
  type WorkspaceRowFactReader
} from '../../../../src/shared/workspace-view/workspace-row-filters'
import type { FilterState, WorkspaceListItem, Worktree } from './workspace-list-types'
import { resolveWorktreeHostId } from '../row-presentation/worktree-host-context-labels'
import { getWorktreeRowIdentity } from '../row-presentation/worktree-host-row-identity'

// Idle prompts have no recent output; live terminals or unread output still count as active.
export function isWorktreeActive(
  w: Pick<Worktree, 'hasHostSidebarActivity' | 'status' | 'liveTerminalCount'> & {
    unread?: boolean
  }
): boolean {
  return w.hasHostSidebarActivity !== undefined
    ? w.hasHostSidebarActivity
    : Boolean(w.unread) || (w.status ? w.status !== 'inactive' : w.liveTerminalCount > 0)
}

// Older hosts omit the main-worktree flag; use the legacy branch heuristic.
function guessDefaultBranchWorkspace(w: Worktree): boolean {
  if (w.isMainWorktree !== undefined) {
    return w.isMainWorktree && w.branch.trim() !== ''
  }
  const branch = w.branch.replace(/^refs\/heads\//, '')
  return branch === 'main' || branch === 'master'
}

// The same host the phone resolves for the row; unknown hosts fall to the shared check's own rule.
export function isPhoneRowInHiddenProject(
  w: Worktree,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>,
  hiddenProjects: HiddenProjects
): boolean {
  return hiddenProjects.isRowHidden({
    repoId: w.repoId,
    hostId: w.hostId ?? repoHostIdByRepoId.get(w.repoId)
  })
}

function phoneRowFacts(
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>,
  hiddenProjects: HiddenProjects,
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]> | undefined
): WorkspaceRowFactReader<Worktree> {
  const parentByChild = new Map(
    [...(childrenByParentIdentity ?? [])].flatMap(([parent, children]) =>
      children.map((child) => [getWorktreeRowIdentity(child), parent] as const)
    )
  )
  return {
    isArchived: (w) => w.isArchived === true,
    isInHiddenProject: (w) =>
      isPhoneRowInHiddenProject(w, repoHostIdByRepoId, hiddenProjects) &&
      !isListedByFolderWorkspace(getWorktreeRowIdentity(w), (id) => parentByChild.get(id)),
    isProjectHidden: hiddenProjects.isProjectHidden,
    isFolderWorkspace: (w) => w.workspaceKind === 'folder-workspace',
    repoId: (w) => w.repoId,
    hostId: (w) => resolveWorktreeHostId(w, repoHostIdByRepoId),
    isOtherClient: (w) => w.desktopOtherClient === true,
    isDefaultBranch: (w) => w.defaultBranch ?? guessDefaultBranchWorkspace(w),
    isAutomationCreated: (w) => w.automationCreated === true,
    isCliCreated: (w) => w.cliCreated === true,
    isDetachedHead: (w) => w.detachedHead === true,
    // Why the guess: #8873's exemption must fail open on hosts that predate isMainWorktree.
    isMainWorktree: (w) => w.isMainWorktree ?? guessDefaultBranchWorkspace(w),
    isSleeping: (w) => !isWorktreeActive(w)
  }
}

export type SearchFilteredWorktrees = {
  rows: Worktree[]
  /** Search matches only the filters hide; listed anyway and tagged Hidden, as desktop Cmd+J does. */
  filterHiddenIdentities: ReadonlySet<string>
}

const NO_FILTER_HIDDEN: ReadonlySet<string> = new Set()

function matchesSearch(w: Worktree, q: string): boolean {
  return (
    w.displayName.toLowerCase().includes(q) ||
    w.branch.toLowerCase().includes(q) ||
    w.repo.toLowerCase().includes(q)
  )
}

export function filterWorktreesForSearch(
  worktrees: Worktree[],
  filters: FilterState,
  search: string,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId> = new Map(),
  hiddenProjects: HiddenProjects = NO_HIDDEN_PROJECTS,
  /** The list's nesting; a hidden project's row under a folder workspace stays listed. */
  childrenByParentIdentity?: ReadonlyMap<string, readonly Worktree[]>
): SearchFilteredWorktrees {
  const facts = phoneRowFacts(repoHostIdByRepoId, hiddenProjects, childrenByParentIdentity)
  const q = search.trim().toLowerCase()
  if (!q) {
    return {
      rows: filterWorkspaceRows(worktrees, filters, facts),
      filterHiddenIdentities: NO_FILTER_HIDDEN
    }
  }
  const { visible, hiddenByFilters } = partitionWorkspaceRowsByFilters(worktrees, filters, facts)
  const hiddenMatches = hiddenByFilters.filter((w) => matchesSearch(w, q))
  if (hiddenMatches.length === 0) {
    return {
      rows: visible.filter((w) => matchesSearch(w, q)),
      filterHiddenIdentities: NO_FILTER_HIDDEN
    }
  }
  const listed = new Set([...visible.filter((w) => matchesSearch(w, q)), ...hiddenMatches])
  return {
    rows: worktrees.filter((w) => listed.has(w)),
    filterHiddenIdentities: new Set(hiddenMatches.map(getWorktreeRowIdentity))
  }
}

export function filterWorktrees(...args: Parameters<typeof filterWorktreesForSearch>): Worktree[] {
  return filterWorktreesForSearch(...args).rows
}

/** Tags the listed rows the filters hide (see filterWorktreesForSearch). */
export function withFilterHiddenTags<Item extends WorkspaceListItem>(
  items: Item[],
  filterHiddenIdentities: ReadonlySet<string>
): Item[] {
  if (filterHiddenIdentities.size === 0) {
    return items
  }
  return items.map((item) =>
    filterHiddenIdentities.has(getWorktreeRowIdentity(item.row))
      ? { ...item, view: { ...item.view, filterHidden: true } }
      : item
  )
}
