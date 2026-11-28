import { getRepoExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { resolveRepoBadgeColor } from '../../../../src/shared/repository/appearance/repo-badge-color'
import { buildSectionRepoMap } from '../workspace-list/section-repo-map'
import type { SectionRepo, Worktree } from '../workspace-list/workspace-list-types'
import type { Translate } from '../../i18n/mobile-i18n'
import { isRepoHidden } from '../../../../src/shared/project/catalog/hidden-projects'

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
  worktrees: readonly Worktree[],
  t: Translate
): WorkspaceSectionRepo[] {
  const repos =
    filterCatalogRepos.length > 0
      ? filterCatalogRepos
      : [...buildSectionRepoMap([], worktrees, t).values()]
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    const key = `${getRepoExecutionHostId(repo)}|${repo.id}`
    if (seen.has(key) || isRepoHidden(repo)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}
