import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader
} from '../../../src/shared/workspace-view/workspace-row-filters'
import type { FilterState, Worktree } from './workspace-list-types'
import { resolveWorktreeHostId } from './worktree-host-context-labels'
import { isWorktreeActive } from './worktree-row-status'

/** An older host's row says nothing about its default branch; guess the way the phone always has. */
function guessDefaultBranchWorkspace(w: Worktree): boolean {
  if (w.isMainWorktree !== undefined) {
    return w.isMainWorktree && w.branch.trim() !== ''
  }
  // Why: hosts that predate isMainWorktree in worktree.ps; main/master is the only signal.
  const branch = w.branch.replace(/^refs\/heads\//, '')
  return branch === 'main' || branch === 'master'
}

/** The facts the shared Workspace options filters read, from what the host stamped on each row. */
function phoneRowFacts(
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): WorkspaceRowFactReader<Worktree> {
  return {
    isArchived: (w) => w.isArchived === true,
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

/** The rows the desktop's Workspace options and the phone's search keep, in their given order. */
export function filterWorktrees(
  worktrees: Worktree[],
  filters: FilterState,
  search: string,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId> = new Map()
): Worktree[] {
  const result = filterWorkspaceRows(worktrees, filters, phoneRowFacts(repoHostIdByRepoId))
  const q = search.trim().toLowerCase()
  if (!q) {
    return result
  }
  return result.filter(
    (w) =>
      w.displayName.toLowerCase().includes(q) ||
      w.branch.toLowerCase().includes(q) ||
      w.repo.toLowerCase().includes(q)
  )
}
