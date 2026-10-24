import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { getLogicalRepoOrderRankById } from '../../../src/shared/project-section-order'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { ServedProjectSections } from './project-sections-operations'
import { NO_PROJECT_SECTION_CATALOG, type ProjectSectionCatalog } from './workspace-list-sections'
import type { SectionRepo } from './workspace-list-types'

/**
 * Project grouping's inputs: the desktop sidebar's own catalog when it serves one, else (an older
 * desktop) its own repos with no projects, so rows group by repo. Only shown hosts' repos open
 * empty sections; the grouping itself spans every host, as the desktop's does.
 */
export function buildProjectSectionCatalog(
  served: ServedProjectSections | null,
  desktopRepos: readonly SectionRepo[],
  visibleHostIds: readonly ExecutionHostId[] | null,
  /** The shared UI value; null until read, when the served one stands in. */
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
