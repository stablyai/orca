import { useMemo } from 'react'
import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type {
  WorkspaceGroupBy,
  WorkspaceSortBy
} from '../../../src/shared/workspace-view/workspace-view-options'
import {
  buildSectionRepoMap,
  buildMobileWorkspacePlan,
  type FilterState,
  type ProjectSectionCatalog,
  type Section,
  type SectionRepo,
  type Worktree
} from './workspace-list-sections'
import { buildFilterRepos, type WorkspaceSectionRepo } from './workspace-filter-repos'

export function useWorkspaceSections(args: {
  displayWorktrees: Worktree[]
  sortMode: WorkspaceSortBy
  filters: FilterState
  search: string
  groupMode: WorkspaceGroupBy
  pinnedIds: Set<string>
  showPinnedInGroups: boolean
  projectCatalog: ProjectSectionCatalog
  /** Every catalog repo on every host, which is what the desktop's filter lists. */
  filterCatalogRepos: readonly SectionRepo[]
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  /** Each repo's host, for rows that predate their own hostId. */
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
}): {
  sections: Section[]
  rawSections: Section[]
  uniqueRepos: WorkspaceSectionRepo[]
  repoById: ReadonlyMap<string, SectionRepo>
} {
  const {
    displayWorktrees,
    sortMode,
    filters,
    search,
    groupMode,
    pinnedIds,
    showPinnedInGroups,
    projectCatalog,
    filterCatalogRepos,
    collapsedGroups,
    workspaceStatuses,
    repoHostIdByRepoId
  } = args

  const uniqueRepos = useMemo(
    () => buildFilterRepos(filterCatalogRepos, displayWorktrees),
    [filterCatalogRepos, displayWorktrees]
  )

  const repoById = useMemo(
    () => buildSectionRepoMap(projectCatalog.repos, displayWorktrees),
    [projectCatalog.repos, displayWorktrees]
  )

  const plan = useMemo(
    () =>
      buildMobileWorkspacePlan(
        displayWorktrees,
        sortMode,
        filters,
        search,
        groupMode,
        pinnedIds,
        projectCatalog,
        workspaceStatuses,
        undefined,
        showPinnedInGroups,
        repoHostIdByRepoId
      ),
    [
      repoHostIdByRepoId,
      displayWorktrees,
      sortMode,
      filters,
      search,
      groupMode,
      pinnedIds,
      projectCatalog,
      workspaceStatuses,
      showPinnedInGroups
    ]
  )

  const rawSections = useMemo(() => plan.render(collapsedGroups), [plan, collapsedGroups])

  const sections = useMemo(
    () =>
      rawSections.map((s) => ({
        ...s,
        data: collapsedGroups.has(s.key) ? [] : s.data
      })),
    [rawSections, collapsedGroups]
  )

  return { sections, rawSections, uniqueRepos, repoById }
}
