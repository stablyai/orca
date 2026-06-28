import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeStatus
} from '../../shared/runtime-types'

/** Provider-agnostic links surfaced as sidebar badges. Only one issue/PR field
 *  is typically set per worktree, but all providers are carried so the view
 *  never hard-codes GitHub. */
export type WorktreeBadges = {
  unread: boolean
  liveTerminalCount: number
  issue: number | null
  pr: { number: number; state: string } | null
  gitLabMr: number | null
  gitLabIssue: number | null
  linearIssue: string | null
}

export type WorktreeRow = {
  worktreeId: string
  repoId: string
  displayName: string
  branch: string
  status: RuntimeWorktreeStatus
  agents: RuntimeWorktreeAgentRow[]
  isActive: boolean
  isPinned: boolean
  hasAttachedPty: boolean
  lastOutputAt: number | null
  preview: string
  parentWorktreeId: string | null
  badges: WorktreeBadges
}

export type WorktreeRepoGroup = {
  repoId: string
  repo: string
  worktrees: WorktreeRow[]
}

export type WorktreeSnapshot = {
  groups: WorktreeRepoGroup[]
  totalCount: number
  truncated: boolean
}

function toRow(summary: RuntimeWorktreePsSummary): WorktreeRow {
  return {
    worktreeId: summary.worktreeId,
    repoId: summary.repoId,
    displayName: summary.displayName,
    branch: summary.branch,
    status: summary.status,
    // Defensive: the runtime may omit agents for shell-only worktrees; normalize
    // to an array so consumers can always iterate.
    agents: summary.agents ?? [],
    isActive: summary.isActive,
    isPinned: summary.isPinned,
    hasAttachedPty: summary.hasAttachedPty,
    lastOutputAt: summary.lastOutputAt,
    preview: summary.preview,
    parentWorktreeId: summary.parentWorktreeId,
    badges: {
      // The runtime sometimes omits link fields (undefined) rather than sending
      // null; coerce so the formatter's null checks render nothing, not
      // "undefined".
      unread: summary.unread ?? false,
      liveTerminalCount: summary.liveTerminalCount ?? 0,
      issue: summary.linkedIssue ?? null,
      pr: summary.linkedPR ?? null,
      gitLabMr: summary.linkedGitLabMR ?? null,
      gitLabIssue: summary.linkedGitLabIssue ?? null,
      linearIssue: summary.linkedLinearIssue ?? null
    }
  }
}

/** Worktrees the dashboard hides: dormant ones with no agents and no live
 *  terminals. An inactive worktree that still has a running terminal stays
 *  visible so you don't lose access to it. */
function isHiddenWorktree(summary: RuntimeWorktreePsSummary): boolean {
  return (
    summary.status === 'inactive' &&
    (summary.agents?.length ?? 0) === 0 &&
    summary.liveTerminalCount === 0
  )
}

/** Normalize a worktree.ps result into a stable, repo-grouped view model.
 *  Repo order follows first appearance; worktree order within a repo follows
 *  the runtime's order (newest-state-first), so the sidebar can diff stably.
 *  Dormant inactive worktrees are filtered out to keep the list focused. */
export function buildWorktreeSnapshot(result: RuntimeWorktreePsResult): WorktreeSnapshot {
  const groups: WorktreeRepoGroup[] = []
  const byRepoId = new Map<string, WorktreeRepoGroup>()

  for (const summary of result.worktrees) {
    if (isHiddenWorktree(summary)) {
      continue
    }
    let group = byRepoId.get(summary.repoId)
    if (!group) {
      group = { repoId: summary.repoId, repo: summary.repo, worktrees: [] }
      byRepoId.set(summary.repoId, group)
      groups.push(group)
    }
    group.worktrees.push(toRow(summary))
  }

  return { groups, totalCount: result.totalCount, truncated: result.truncated }
}

/** Flatten the grouped snapshot into a single ordered list of selectable rows,
 *  matching the top-to-bottom order the sidebar renders. */
export function flattenWorktreeRows(snapshot: WorktreeSnapshot): WorktreeRow[] {
  return snapshot.groups.flatMap((group) => group.worktrees)
}
