import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { repoColor } from './repo-color'
import { buildSectionRepoMap, type SectionRepo, type Worktree } from './workspace-list-sections'

export type WorkspaceSectionRepo = {
  /** Unique per host: two hosts can each hold a repo of the same name. */
  key: string
  name: string
  id: string
  color: string
}

export function sectionRepoColor(repo: Pick<SectionRepo, 'badgeColor' | 'displayName'>): string {
  return (typeof repo.badgeColor === 'string' && repo.badgeColor) || repoColor(repo.displayName)
}

// List catalog repos per host; before catalogs arrive, derive candidates from workspace rows.
export function buildFilterRepos(
  filterCatalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[]
): WorkspaceSectionRepo[] {
  const repos =
    filterCatalogRepos.length > 0
      ? filterCatalogRepos
      : [...buildSectionRepoMap([], worktrees).values()]
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    const key = `${getRepoExecutionHostId(repo)}|${repo.id}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}
