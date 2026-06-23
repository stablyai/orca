// Pure data transforms for the host workspaces list: status derivation,
// filtering, sorting, and grouping into SectionList sections. Kept out of the
// screen component so the screen stays under its line cap and the logic is
// unit-testable in isolation.

import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'

export type Worktree = {
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  repo: string
  branch: string
  displayName: string
  // Why: on-disk worktree directory path. Needed by NewWorktreeModal so the
  // marine-creature fallback dedupes against the actual filesystem basenames
  // (matching the desktop's collision check), not against displayName which
  // the user may have renamed.
  path: string
  isArchived?: boolean
  isMainWorktree?: boolean
  hasHostSidebarActivity?: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  preview: string
  unread: boolean
  lastOutputAt?: number
  isPinned: boolean
  isActive?: boolean
  linkedPR: { number: number; state: string } | null
  linkedIssue?: number | null
  linkedLinearIssue?: string | null
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  comment?: string
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  agents?: RuntimeWorktreeAgentRow[]
}

// Desktop's filter model (shared via PersistedUIState): repos selected by id,
// plus two hide toggles. There is no "active only" — hideSleeping is the
// inverse intent.
export type FilterState = {
  filterRepoIds: Set<string>
  hideSleeping: boolean
  hideDefaultBranch: boolean
}

export type Section = { title: string; icon?: 'pin'; data: Worktree[] }

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

export const WORKSPACE_STATUS_LABELS: Record<ReturnType<typeof getWorktreeStatus>, string> = {
  permission: 'Needs Permission',
  working: 'Working',
  done: 'Done',
  active: 'Active',
  inactive: 'Inactive'
}

export const WORKSPACE_STATUS_ORDER: ReturnType<typeof getWorktreeStatus>[] = [
  'permission',
  'working',
  'done',
  'active',
  'inactive'
]

export function sortWorktrees(worktrees: Worktree[], mode: MobileSortMode): Worktree[] {
  // 'manual' keeps the server (worktree.ps) order untouched.
  if (mode === 'manual') {
    return worktrees
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
    // 'smart' — attention-first
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

// Why: matches desktop's PR_GROUP_META naming from worktree-list-groups.ts.
// no PR/draft/unknown → "In Progress", open → "In Review", merged → "Done", closed → "Closed"
type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

const PR_GROUP_LABELS: Record<PRGroupKey, string> = {
  done: 'Done',
  'in-review': 'In Review',
  'in-progress': 'In Progress',
  closed: 'Closed'
}

const PR_GROUP_ORDER: PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

function getPRGroupKey(w: Worktree): PRGroupKey {
  if (!w.linkedPR) {
    return 'in-progress'
  }
  const s = w.linkedPR.state.toLowerCase()
  if (s === 'merged') {
    return 'done'
  }
  if (s === 'closed') {
    return 'closed'
  }
  if (s === 'draft') {
    return 'in-progress'
  }
  return 'in-review'
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
  repoIdsByName: ReadonlyMap<string, string> = new Map()
): Section[] {
  const filtered = filterWorktrees(worktrees, filters, search)
  const sorted = sortWorktrees(filtered, sortMode)

  const pinned = sorted.filter((w) => isWorktreePinned(w, pinnedIds))
  const unpinned = sorted.filter((w) => !isWorktreePinned(w, pinnedIds))
  const active = unpinned.filter(isWorktreeActive)
  const inactive = unpinned.filter((w) => !isWorktreeActive(w))

  const sections: Section[] = []
  if (pinned.length > 0) {
    sections.push({ title: 'Pinned', icon: 'pin', data: pinned })
  }

  if (groupMode === 'none') {
    if (active.length > 0) {
      // Why: without explicit grouping, mobile's primary workflow is jumping
      // back into running sessions before browsing the full worktree archive.
      sections.push({ title: 'Active', data: active })
    }
    if (inactive.length > 0) {
      sections.push({ title: pinned.length > 0 || active.length > 0 ? 'All' : '', data: inactive })
    }
  } else if (groupMode === 'repo') {
    const byRepo = new Map<string, Worktree[]>()
    for (const w of unpinned) {
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
      sections.push({ title: repo, data: items })
    }
  } else if (groupMode === 'workspaceStatus') {
    const byStatus = new Map<ReturnType<typeof getWorktreeStatus>, Worktree[]>()
    for (const w of unpinned) {
      const key = getWorktreeStatus(w)
      const list = byStatus.get(key)
      if (list) {
        list.push(w)
      } else {
        byStatus.set(key, [w])
      }
    }
    for (const status of WORKSPACE_STATUS_ORDER) {
      const items = byStatus.get(status)
      if (items && items.length > 0) {
        sections.push({ title: WORKSPACE_STATUS_LABELS[status], data: items })
      }
    }
  } else if (groupMode === 'prStatus') {
    const byGroup = new Map<PRGroupKey, Worktree[]>()
    for (const w of unpinned) {
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
        sections.push({ title: PR_GROUP_LABELS[groupKey], data: items })
      }
    }
  }

  return sections
}
