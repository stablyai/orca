import type { WorkspaceStatusDefinition } from '../../../src/shared/types'
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

export type { FilterState, Section, Worktree } from './workspace-list-types'

function makeSection(
  key: string,
  title: string,
  data: Worktree[],
  icon?: 'pin',
  collapsedGroups?: ReadonlySet<string>
): Section {
  const rows = collapsedGroups ? applyMobileWorkspaceLineage(data, collapsedGroups) : data
  return {
    key,
    title,
    ...(icon ? { icon } : {}),
    data: rows.map((worktree) => ({
      ...worktree,
      sectionListKey: `${key}:${worktree.worktreeId}`
    }))
  }
}

export function getWorktreeStatus(
  w: Worktree
): 'working' | 'active' | 'permission' | 'done' | 'inactive' {
  // Why: desktop's sidebar activity is the parity source. Runtime status may
  // still report retained/background PTYs as active after desktop hides them.
  if (w.hasHostSidebarActivity === false) {
    return 'inactive'
  }
  if (w.status && w.status !== 'inactive') {
    return w.status
  }
  if (w.hasHostSidebarActivity === true) {
    return 'active'
  }
  if (w.status) {
    return w.status
  }
  if (w.liveTerminalCount > 0) {
    return 'active'
  }
  return 'inactive'
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

function getManualSortRank(worktree: Worktree): number | null {
  const rank = worktree.manualOrder ?? worktree.sortOrder
  return typeof rank === 'number' && Number.isFinite(rank) ? rank : null
}

export function sortWorktrees(worktrees: Worktree[], mode: MobileSortMode): Worktree[] {
  if (mode === 'manual') {
    return [...worktrees].sort((a, b) => {
      const aRank = getManualSortRank(a)
      const bRank = getManualSortRank(b)
      if (aRank !== null && bRank !== null && aRank !== bRank) {
        // Why: desktop assigns higher sort/manual ranks to earlier list positions.
        return bRank - aRank
      }
      if (aRank !== null && bRank === null) {
        return -1
      }
      if (aRank === null && bRank !== null) {
        return 1
      }
      return 0
    })
  }
  return [...worktrees].sort((a, b) => {
    if (mode === 'name') {
      return (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
    }
    if (mode === 'recent') {
      return (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
    }
    if (mode === 'repo') {
      const repoComparison = a.repo.localeCompare(b.repo, undefined, { sensitivity: 'base' })
      return repoComparison || (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
    }
    if (a.unread !== b.unread) {
      return a.unread ? -1 : 1
    }
    const aStatus = getWorktreeStatus(a)
    const bStatus = getWorktreeStatus(b)
    const statusOrder = { permission: 0, working: 1, done: 2, active: 3, inactive: 4 }
    if (statusOrder[aStatus] !== statusOrder[bStatus]) {
      return statusOrder[aStatus] - statusOrder[bStatus]
    }
    if ((a.lastOutputAt ?? 0) !== (b.lastOutputAt ?? 0)) {
      return (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
    }
    return (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
  })
}

export function filterWorktrees(
  worktrees: Worktree[],
  filters: FilterState,
  search: string
): Worktree[] {
  let result = worktrees.filter((w) => !w.isArchived)
  if (filters.hideSleeping) {
    result = result.filter(isWorktreeActive)
  }
  if (filters.hideDefaultBranch) {
    result = result.filter((w) => !isDefaultBranchWorkspace(w))
  }
  if (filters.filterRepoIds.size > 0) {
    result = result.filter((w) => filters.filterRepoIds.has(w.repoId))
  }
  if (search.trim()) {
    const q = search.toLowerCase()
    result = result.filter(
      (w) =>
        (w.displayName || w.repo).toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q) ||
        w.repo.toLowerCase().includes(q)
    )
  }
  return result
}

export function isWorktreePinned(w: Worktree, localPins: Set<string>): boolean {
  return w.isPinned || localPins.has(w.worktreeId)
}

export function buildSections(
  worktrees: Worktree[],
  sortMode: MobileSortMode,
  filters: FilterState,
  search: string,
  groupMode: MobileGroupMode,
  pinnedIds: Set<string>,
  repoIdsByName: ReadonlyMap<string, string> = new Map(),
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = DEFAULT_MOBILE_WORKSPACE_STATUSES,
  collapsedGroups: ReadonlySet<string> = new Set()
): Section[] {
  const filtered = filterWorktrees(worktrees, filters, search)
  const sorted = sortWorktrees(filtered, sortMode)

  const pinned = sorted.filter((w) => isWorktreePinned(w, pinnedIds))
  const unpinned = sorted.filter((w) => !isWorktreePinned(w, pinnedIds))
  // Why: mobile shows pinned workspaces once in the pinned section; duplicating
  // them in status/project sections makes the phone list harder to scan.
  const canonicalGroupWorktrees = unpinned
  const active = canonicalGroupWorktrees.filter(isWorktreeActive)
  const inactive = canonicalGroupWorktrees.filter((w) => !isWorktreeActive(w))

  const sections: Section[] = []
  if (pinned.length > 0) {
    sections.push(makeSection('pinned', 'Pinned', pinned, 'pin'))
  }

  if (groupMode === 'none') {
    if (active.length > 0) {
      sections.push(makeSection('all-active', 'Active', active, undefined, collapsedGroups))
    }
    if (inactive.length > 0) {
      sections.push(
        makeSection(
          'all',
          pinned.length > 0 || active.length > 0 ? 'All' : '',
          inactive,
          undefined,
          collapsedGroups
        )
      )
    }
  } else if (groupMode === 'repo') {
    const byRepo = new Map<string, Worktree[]>()
    for (const w of canonicalGroupWorktrees) {
      const key = w.repo || 'Unknown'
      const list = byRepo.get(key)
      if (list) {
        list.push(w)
      } else {
        byRepo.set(key, [w])
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
      if (!byRepo.has(displayName)) {
        byRepo.set(displayName, [])
      }
    }
    for (const [repo, items] of byRepo) {
      const key = `repo:${repoIdsByName.get(repo) ?? repo}`
      sections.push(makeSection(key, repo, items, undefined, collapsedGroups))
    }
  } else if (groupMode === 'workspaceStatus') {
    const renderableWorkspaceStatuses = coerceMobileWorkspaceStatuses(workspaceStatuses)
    const byStatus = new Map<string, Worktree[]>()
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
    const byGroup = new Map<string, Worktree[]>()
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
            `pr:${groupKey}`,
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
