import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../src/shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../src/shared/project/groups/project-group-types'
import { filterProjectGroupsForVisibleHosts } from '../../../../src/shared/sidebar-list/hosts/host-filtering'
import { getLogicalRepoOrderRankById } from '../../../../src/shared/sidebar-list/sections/project-section-order'
import type { ProjectOrderBy } from '../../../../src/shared/ui-chrome/ui-chrome-types'
import type { ServedProjectSections } from '../../../../src/shared/sidebar-list/catalog/project-section-catalog-schema'
import {
  NO_PROJECT_SECTION_CATALOG,
  type ProjectSectionCatalog
} from '../workspace-list/workspace-list-sections'
import type { SectionRepo } from '../workspace-list/workspace-list-types'

// Use served all-host project grouping; older desktops fall back to repo grouping.
// Only visible hosts’ repos open empty sections, and only their project groups list.
// Groups nest only a served catalog's repos, the only ones that name their group.
export function buildProjectSectionCatalog(
  served: ServedProjectSections | null,
  desktopRepos: readonly SectionRepo[],
  /** The host's own groups (projectGroup.list), for a desktop whose catalog carries none. */
  hostProjectGroups: readonly ProjectGroup[],
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
  // Why: the desktop withholds uploaded image icons from the snapshot; its repo.list still carries them.
  const iconKey = (repo: SectionRepo) => `${getRepoExecutionHostId(repo)}|${repo.id}`
  const iconByKey = new Map(desktopRepos.map((repo) => [iconKey(repo), repo.repoIcon]))
  const repos = served.repos.map((repo) => {
    const icon = repo.repoIcon ? undefined : iconByKey.get(iconKey(repo))
    return icon ? { ...repo, repoIcon: icon } : repo
  })
  // Why: desktops older than #31102 serve no group membership, so their groups would list empty.
  const groupsReadable = served.projectGroups || served.repos.some((repo) => repo.projectGroupId)
  const projectGroups = filterProjectGroupsForVisibleHosts(
    (groupsReadable && (served.projectGroups ?? hostProjectGroups)) || [],
    visibleHostIds ? new Set(visibleHostIds) : null,
    LOCAL_EXECUTION_HOST_ID
  )
  return {
    repos: shown(repos),
    grouping: { projects: served.projects, projectHostSetups: served.setups },
    projectGroups,
    // Why: served repos come in the sidebar's header order, cross-host manual order included.
    repoOrder: getLogicalRepoOrderRankById(served.repos.map((repo) => repo.id)),
    projectOrderBy: projectOrderBy ?? served.projectOrderBy
  }
}
