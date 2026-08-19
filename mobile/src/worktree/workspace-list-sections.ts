import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import {
  DEFAULT_MOBILE_WORKSPACE_STATUSES,
  coerceMobileWorkspaceStatuses,
  getMobileWorkspaceStatus,
  getMobileWorkspaceStatusGroupKey
} from './mobile-workspace-statuses'
import { applyMobileWorkspaceLineage } from './mobile-workspace-lineage'
import { getPRGroupKey, PR_GROUP_LABELS, PR_GROUP_ORDER } from './workspace-pr-status-groups'
import type { FilterState, Section, Worktree } from './workspace-list-types'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'
import { sortWorktrees } from './workspace-list-ordering'

export type { FilterState, Section, Worktree } from './workspace-list-types'
export { CREATE_GRACE_MS, getWorktreeStatus, sortWorktrees } from './workspace-list-ordering'

function sectionIdentity(...parts: string[]): string {
  return JSON.stringify(parts)
}

function makeSection<T extends Worktree>(
  key: string,
  title: string,
  data: T[],
  icon?: 'pin',
  collapsedGroups?: ReadonlySet<string>
): Section<T> {
  const rows = collapsedGroups ? applyMobileWorkspaceLineage(data, collapsedGroups) : data
  return {
    key,
    title,
    ...(icon ? { icon } : {}),
    data: rows.map((worktree) => ({
      ...worktree,
      sectionListKey: sectionIdentity('row', key, worktree.worktreeId)
    }))
  }
}

// Why: the previous 10-minute lastOutputAt window was too strict — most
// worktrees with idle terminal prompts had no recent output and were excluded.
// Any worktree with live terminals or unread output counts as "active".
export function isWorktreeActive(w: Worktree): boolean {
  if (w.hasHostSidebarActivity !== undefined) {
    return w.hasHostSidebarActivity
  }
  if (w.unread) {
    return true
  }
  if (w.status) {
    return w.status !== 'inactive'
  }
  if (w.liveTerminalCount > 0) {
    return true
  }
  return false
}

function isDefaultBranchWorkspace(w: Worktree): boolean {
  if (w.workspaceKind === 'folder-workspace') {
    return false
  }
  if (w.isMainWorktree !== undefined) {
    return w.isMainWorktree && w.branch.trim() !== ''
  }
  // Why: older hosts did not include isMainWorktree in worktree.ps, so keep the
  // legacy fallback until all paired runtimes carry the desktop predicate input.
  const branch = w.branch.replace(/^refs\/heads\//, '')
  return branch === 'main' || branch === 'master'
}

/**
 * Whether "Hide sleeping" must keep this row — the project's entry point (#8873).
 * Falls back to the branch heuristic for hosts that predate isMainWorktree; a
 * folder workspace is always its project's entry point, and isDefaultBranchWorkspace
 * rejects it by design, so it needs its own legacy arm or #8873 still reproduces.
 */
function isSleepingSweepExempt(w: Worktree, alwaysShowDefaultBranch: boolean | undefined): boolean {
  if (alwaysShowDefaultBranch === false) {
    return false
  }
  return w.isMainWorktree ?? (w.workspaceKind === 'folder-workspace' || isDefaultBranchWorkspace(w))
}

function orderMainWorktreeFirst<T extends Worktree>(worktrees: T[]): T[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}

export function filterWorktrees<T extends Worktree>(
  worktrees: T[],
  filters: FilterState,
  search: string
): T[] {
  let result = worktrees.filter((w) => !w.isArchived)
  if (filters.hideSleeping) {
    result = result.filter(
      (w) => isSleepingSweepExempt(w, filters.alwaysShowDefaultBranch) || isWorktreeActive(w)
    )
  }
  if (filters.hideDefaultBranch) {
    result = result.filter((w) => !isDefaultBranchWorkspace(w))
  }
  if (filters.filterRepoIds.size > 0) {
    result = result.filter((w) => filters.filterRepoIds.has(w.repoId))
  }
  const executionHostIds = filters.filterExecutionHostIds
  if (executionHostIds && executionHostIds.size > 0) {
    // Merged rows carry a desktop-scoped id; legacy per-host rows fall back local.
    result = result.filter((w) =>
      executionHostIds.has(w.executionHostFilterId ?? w.hostId ?? LOCAL_EXECUTION_HOST_ID)
    )
  }
  if (search.trim()) {
    const q = search.toLowerCase()
    result = result.filter(
      (w) =>
        w.displayName.toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q) ||
        w.repo.toLowerCase().includes(q)
    )
  }
  return result
}

export function isWorktreePinned(w: Worktree, localPins: Set<string>): boolean {
  return w.isPinned || localPins.has(w.worktreeId)
}

export function buildSections<T extends Worktree>(
  worktrees: T[],
  sortMode: MobileSortMode,
  filters: FilterState,
  search: string,
  groupMode: MobileGroupMode,
  pinnedIds: Set<string>,
  repoIdsByName: ReadonlyMap<string, string> = new Map(),
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = DEFAULT_MOBILE_WORKSPACE_STATUSES,
  collapsedGroups: ReadonlySet<string> = new Set()
): Section<T>[] {
  const filtered = filterWorktrees(worktrees, filters, search)
  const sorted = sortWorktrees(filtered, sortMode)

  const pinned = sorted.filter((w) => isWorktreePinned(w, pinnedIds))
  // Why: desktop treats Pinned as an overlay. Keeping pinned rows in canonical
  // groups preserves exact cross-surface order and literal section counts.
  const canonicalGroupWorktrees = sorted

  const sections: Section<T>[] = []
  if (pinned.length > 0) {
    sections.push(makeSection('pinned', 'Pinned', pinned, 'pin'))
  }

  if (groupMode === 'none') {
    if (canonicalGroupWorktrees.length > 0) {
      sections.push(makeSection('all', 'All', canonicalGroupWorktrees, undefined, collapsedGroups))
    }
  } else if (groupMode === 'repo') {
    const byRepo = new Map<string, { title: string; items: T[] }>()
    for (const w of canonicalGroupWorktrees) {
      const key = w.repoId || w.repo || 'Unknown'
      const group = byRepo.get(key)
      if (group) {
        group.items.push(w)
      } else {
        byRepo.set(key, { title: w.repo || 'Unknown', items: [w] })
      }
    }
    const representedRepoIds = new Set(worktrees.map((w) => w.repoId))
    const query = search.trim().toLowerCase()
    for (const [displayName, id] of repoIdsByName) {
      if (representedRepoIds.has(id)) {
        continue
      }
      if (filters.filterRepoIds.size > 0 && !filters.filterRepoIds.has(id)) {
        continue
      }
      if (query && !displayName.toLowerCase().includes(query)) {
        continue
      }
      if (!byRepo.has(id)) {
        byRepo.set(id, { title: displayName, items: [] })
      }
    }
    for (const [repoId, group] of byRepo) {
      const key = sectionIdentity('repo', repoId)
      sections.push(
        makeSection(
          key,
          group.title,
          orderMainWorktreeFirst(group.items),
          undefined,
          collapsedGroups
        )
      )
    }
  } else if (groupMode === 'workspaceStatus') {
    const renderableWorkspaceStatuses = coerceMobileWorkspaceStatuses(workspaceStatuses)
    const byStatus = new Map<string, T[]>()
    for (const w of canonicalGroupWorktrees) {
      const key = getMobileWorkspaceStatus(w, renderableWorkspaceStatuses)
      const list = byStatus.get(key)
      if (list) {
        list.push(w)
      } else {
        byStatus.set(key, [w])
      }
    }
    for (const status of renderableWorkspaceStatuses) {
      const items = byStatus.get(status.id)
      if (items && items.length > 0) {
        sections.push(
          makeSection(
            getMobileWorkspaceStatusGroupKey(status.id),
            status.label,
            items,
            undefined,
            collapsedGroups
          )
        )
      }
    }
  } else if (groupMode === 'prStatus') {
    const byGroup = new Map<string, T[]>()
    for (const w of canonicalGroupWorktrees) {
      const key = getPRGroupKey(w)
      const list = byGroup.get(key)
      if (list) {
        list.push(w)
      } else {
        byGroup.set(key, [w])
      }
    }
    for (const groupKey of PR_GROUP_ORDER) {
      const items = byGroup.get(groupKey)
      if (items && items.length > 0) {
        sections.push(
          makeSection(
            sectionIdentity('pr', groupKey),
            PR_GROUP_LABELS[groupKey],
            items,
            undefined,
            collapsedGroups
          )
        )
      }
    }
  }

  return sections
}
