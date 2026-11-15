import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import { NO_HIDDEN_PROJECTS, type HiddenProjects } from '../../../../src/shared/hidden-projects'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader
} from '../../../../src/shared/workspace-view/workspace-row-filters'
import type { FilterState, Worktree } from './workspace-list-types'
import { resolveWorktreeHostId } from '../row-presentation/worktree-host-context-labels'

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

function phoneRowFacts(
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>,
  hiddenProjects: HiddenProjects
): WorkspaceRowFactReader<Worktree> {
  return {
    isArchived: (w) => w.isArchived === true,
    // The same host the phone resolves for the row; unknown hosts fall to the shared check's own rule.
    isInHiddenProject: (w) =>
      hiddenProjects.isRowHidden({
        repoId: w.repoId,
        hostId: w.hostId ?? repoHostIdByRepoId.get(w.repoId)
      }),
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

export function filterWorktrees(
  worktrees: Worktree[],
  filters: FilterState,
  search: string,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId> = new Map(),
  hiddenProjects: HiddenProjects = NO_HIDDEN_PROJECTS
): Worktree[] {
  const result = filterWorkspaceRows(
    worktrees,
    filters,
    phoneRowFacts(repoHostIdByRepoId, hiddenProjects)
  )
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
