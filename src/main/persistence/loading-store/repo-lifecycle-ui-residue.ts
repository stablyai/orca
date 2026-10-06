import type { PersistedState } from '../../../shared/persisted-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

/** Mutates UI state to remove selections and preferences whose owning repositories were deregistered. */
export function pruneDeregisteredRepoUiResidue(
  ui: PersistedState['ui'],
  orphanRepoIds: ReadonlySet<string>
): void {
  const isOrphanWorktree = (worktreeId: string): boolean =>
    orphanRepoIds.has(getRepoIdFromWorktreeId(worktreeId))
  if (ui.lastActiveRepoId && orphanRepoIds.has(ui.lastActiveRepoId)) {
    ui.lastActiveRepoId = null
  }
  if (ui.lastActiveWorktreeId && isOrphanWorktree(ui.lastActiveWorktreeId)) {
    ui.lastActiveWorktreeId = null
  }
  ui.filterRepoIds = ui.filterRepoIds?.filter((repoId) => !orphanRepoIds.has(repoId)) ?? []
  for (const record of [ui.explorerDisplayRootByWorktree, ui.showDotfilesByWorktree]) {
    for (const worktreeId of Object.keys(record ?? {})) {
      if (isOrphanWorktree(worktreeId)) {
        delete record?.[worktreeId]
      }
    }
  }
}
