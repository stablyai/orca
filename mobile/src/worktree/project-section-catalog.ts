import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { getLogicalRepoOrderRankById } from '../../../src/shared/project-section-order'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import type { Repo } from '../../../src/shared/repo-types'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { ServedProjectSections } from './project-sections-operations'
import { NO_PROJECT_SECTION_CATALOG, type ProjectSectionCatalog } from './workspace-list-sections'
import type { SectionRepo } from './workspace-list-types'

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
  const shownDesktopRepos = shown(desktopRepos)
  if (!served) {
    return {
      ...NO_PROJECT_SECTION_CATALOG,
      repos: shownDesktopRepos,
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
  const shownRepos = shown(repos)
  const setups = [...served.setups]
  const projects = [...served.projects]
  const knownRepoIds = new Set(setups.map((s) => s.repoId))
  const desktopOnlyRepos = shownDesktopRepos.filter(
    (repo) => !shownRepos.some((shown) => iconKey(shown) === iconKey(repo))
  )
  const unrepresentedRepos = desktopOnlyRepos.filter((repo) => !knownRepoIds.has(repo.id))
  if (unrepresentedRepos.length > 0) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SectionRepo fields satisfy Repo for projection derivation.
    const derived = projectHostSetupProjectionFromRepos(unrepresentedRepos as readonly Repo[])
    setups.push(...derived.setups)
    projects.push(...derived.projects)
  }
  return {
    repos: [...shownRepos, ...desktopOnlyRepos],
    grouping: { projects, projectHostSetups: setups },
    // Why: served repos come in the sidebar's header order, cross-host manual order included.
    repoOrder: getLogicalRepoOrderRankById(served.repos.map((repo) => repo.id)),
    projectOrderBy: projectOrderBy ?? served.projectOrderBy
  }
}
