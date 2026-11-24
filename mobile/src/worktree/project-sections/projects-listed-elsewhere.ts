import type { ProjectSectionCatalog } from '../workspace-list/workspace-list-sections'
import type { Worktree } from '../workspace-list/workspace-list-types'

/** Drops catalog projects whose rows only another section (Bots) lists, so a project with rows is
 *  never drawn as an empty placeholder. */
export function withoutProjectsListedElsewhere(
  catalog: ProjectSectionCatalog,
  shown: readonly Worktree[],
  allHostRows: readonly Worktree[] | undefined
): ProjectSectionCatalog {
  const shownRepoIds = new Set(shown.map((w) => w.repoId))
  const elsewhere = new Set(
    (allHostRows ?? []).map((w) => w.repoId).filter((repoId) => !shownRepoIds.has(repoId))
  )
  return elsewhere.size === 0
    ? catalog
    : { ...catalog, repos: catalog.repos.filter((repo) => !elsewhere.has(repo.id)) }
}
