import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { resolveRepoBadgeColor } from '../../../src/shared/repo-badge-color'
import { isFloatingRepoCandidateId, isFloatingWorktreeRow } from './floating-workspace-section'
import { buildSectionRepoMap, type SectionRepo, type Worktree } from './workspace-list-sections'

export type WorkspaceSectionRepo = {
  /** Unique per host: two hosts can each hold a repo of the same name. */
  key: string
  name: string
  id: string
  color: string
}

export function sectionRepoColor(repo: Pick<SectionRepo, 'badgeColor'>): string {
  return resolveRepoBadgeColor(repo.badgeColor)
}

// List catalog repos per host; before catalogs arrive, derive candidates from workspace rows.
export function buildFilterRepos(
  filterCatalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[]
): WorkspaceSectionRepo[] {
  const nonFloatingWorktrees = worktrees.filter((w) => !isFloatingWorktreeRow(w))
  const repos =
    filterCatalogRepos.length > 0
      ? filterCatalogRepos
      : [...buildSectionRepoMap([], nonFloatingWorktrees).values()]
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    if (isFloatingRepoCandidateId(repo.id)) {
      return []
    }
    const key = `${getRepoExecutionHostId(repo)}|${repo.id}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}
