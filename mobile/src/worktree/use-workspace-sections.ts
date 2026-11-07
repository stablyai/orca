import { useMemo } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
import type { WorktreeHostContextOf } from './worktree-host-context-labels'
import type { MobileLineageStores } from './mobile-workspace-lineage'

export function useWorkspaceSections(args: {
  exactProjectRepoFilters?: boolean
  displayWorktrees: Worktree[]
  hostContextOf: WorktreeHostContextOf
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
  /** The stores the list spans, so a parent on another machine nests its children. */
  lineageStores?: MobileLineageStores
}): {
  sections: Section[]
  rawSections: Section[]
  uniqueRepos: WorkspaceSectionRepo[]
  repoById: ReadonlyMap<string, SectionRepo>
} {
  const t = useMobileTranslation()
  const {
    displayWorktrees,
    hostContextOf,
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
    repoHostIdByRepoId,
    lineageStores
  } = args

  const uniqueRepos = useMemo(
    () =>
      buildFilterRepos(
        filterCatalogRepos,
        displayWorktrees,
        args.exactProjectRepoFilters ? projectCatalog.grouping : undefined
      ),
    [filterCatalogRepos, displayWorktrees, projectCatalog.grouping, args.exactProjectRepoFilters, t]
  )

  const repoById = useMemo(
    () => buildSectionRepoMap(projectCatalog.repos, displayWorktrees),
    [projectCatalog.repos, displayWorktrees, t]
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
        repoHostIdByRepoId,
        lineageStores
      ),
    [
      repoHostIdByRepoId,
      lineageStores,
      displayWorktrees,
      sortMode,
      filters,
      search,
      groupMode,
      pinnedIds,
      projectCatalog,
      workspaceStatuses,
      showPinnedInGroups,
      t
    ]
  )

  const rawSections = useMemo(
    () => plan.render(collapsedGroups, hostContextOf),
    [plan, collapsedGroups, hostContextOf]
  )

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
