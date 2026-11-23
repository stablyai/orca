import type { PersonalProjectOrder } from '../../../../src/shared/personal-project-order'
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
import type { ProjectSectionCatalog, SectionRepo } from '../workspace-list/workspace-list-types'

export type { ProjectSectionCatalog } from '../workspace-list/workspace-list-types'

export const NO_PROJECT_SECTION_CATALOG: ProjectSectionCatalog = {
  repos: [],
  grouping: null,
  projectGroups: [],
  repoOrder: undefined,
  projectOrderBy: 'manual'
}

// Use served all-host project grouping; older desktops fall back to repo grouping.
// Only visible hosts’ repos open empty sections, and only their project groups list.
// Groups nest only a served catalog's repos, the only ones that name their group.
export function buildProjectSectionCatalog(
  served: ServedProjectSections | null,
  desktopRepos: readonly SectionRepo[],
  /** The host's own groups (projectGroup.list), for a desktop whose catalog carries none. */
  hostProjectGroups: readonly ProjectGroup[],
  visibleHostIds: readonly ExecutionHostId[] | null,
  /** The shared UI value; null until read, when the served one stands in. */
  projectOrderBy: ProjectOrderBy | null,
  personalProjectOrder?: PersonalProjectOrder
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
  // Why: the host's own repo.list icon is the drawable one: the snapshot withholds uploads, and an
  // https icon arrives there inlined.
  const iconKey = (repo: SectionRepo) => `${getRepoExecutionHostId(repo)}|${repo.id}`
  const iconByKey = new Map(desktopRepos.map((repo) => [iconKey(repo), repo.repoIcon]))
  const repos = served.repos.map((repo) => {
    const icon = iconByKey.get(iconKey(repo))
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
    grouping: {
      projects: served.projects,
      projectHostSetups: served.setups,
      personalProjectOrder: personalProjectOrder ?? served.personalProjectOrder
    },
    projectGroups,
    // Why: served repos come in the sidebar's header order, cross-host manual order included.
    repoOrder: getLogicalRepoOrderRankById(served.repos.map((repo) => repo.id)),
    projectOrderBy: projectOrderBy ?? served.projectOrderBy
  }
}
