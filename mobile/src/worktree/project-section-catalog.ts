import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { getLogicalRepoOrderRankById } from '../../../src/shared/project-section-order'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { ServedProjectSections } from './project-sections-operations'
import { NO_PROJECT_SECTION_CATALOG, type ProjectSectionCatalog } from './workspace-list-sections'
import type { SectionRepo } from './workspace-list-types'
import { resolveServedProjectSectionClaims } from '../../../src/shared/project-section-catalog-claims'

// Use served all-host project grouping; older desktops fall back to repo grouping.
// Only visible hosts’ repos open empty sections.
export function buildProjectSectionCatalog(
  served: ServedProjectSections | null,
  desktopRepos: readonly SectionRepo[],
  visibleHostIds: readonly ExecutionHostId[] | null,
  projectOrderBy: ProjectOrderBy | null
): ProjectSectionCatalog {
  const shown = (repos: readonly SectionRepo[]) =>
    visibleHostIds
      ? repos.filter((repo) => visibleHostIds.includes(getRepoExecutionHostId(repo)))
      : repos
  if (!served) {
    return {
      ...NO_PROJECT_SECTION_CATALOG,
      repos: shown(desktopRepos),
      projectOrderBy: projectOrderBy ?? NO_PROJECT_SECTION_CATALOG.projectOrderBy
    }
  }
  served = resolveServedProjectSectionClaims(served)
  // Why: the desktop withholds uploaded image icons from the snapshot; its repo.list still carries them.
  const iconKey = (repo: SectionRepo) => `${getRepoExecutionHostId(repo)}|${repo.id}`
  const iconByKey = new Map(desktopRepos.map((repo) => [iconKey(repo), repo.repoIcon]))
  const repos = served.repos.map((repo) => {
    const icon = repo.repoIcon ? undefined : iconByKey.get(iconKey(repo))
    return icon ? { ...repo, repoIcon: icon } : repo
  })
  return {
    repos: shown(repos),
    grouping: { projects: served.projects, projectHostSetups: served.setups },
    // Why: served repos come in the sidebar's header order, cross-host manual order included.
    repoOrder: getLogicalRepoOrderRankById(served.repos.map((repo) => repo.id)),
    projectOrderBy: projectOrderBy ?? served.projectOrderBy
  }
}
