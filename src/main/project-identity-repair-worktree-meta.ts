import { getProjectHostSetupWorktreeMeta } from '../shared/project-host-setup-projection'
import type { ProjectHostSetup, Repo, WorktreeMeta } from '../shared/types'

type WorktreeMetaProjectStore = {
  getProjectHostSetups(): ProjectHostSetup[]
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): unknown
}

/** An identity repair re-keys the repo into the selected project, which can drop the old project
 *  row entirely, orphaning every `WorktreeMeta` row `getProjectHostSetupWorktreeMeta` stamped from
 *  the old projection. Only already-stamped rows are touched: an unstamped row is legacy state
 *  this flow has no mandate to start owning. */
export function remapWorktreeMetaToRepoProject(store: WorktreeMetaProjectStore, repo: Repo): void {
  const stamp = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
  // Worktree meta ids are `<repoId>::<path>` (folder workspace instances add a suffix).
  const prefix = `${repo.id}::`
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (!worktreeId.startsWith(prefix) || !meta.projectId) {
      continue
    }
    if (
      meta.projectId === stamp.projectId &&
      meta.projectHostSetupId === stamp.projectHostSetupId
    ) {
      continue
    }
    store.setWorktreeMeta(worktreeId, stamp)
  }
}
