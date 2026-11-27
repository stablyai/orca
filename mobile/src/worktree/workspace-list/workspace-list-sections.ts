import { orderMainWorktreeFirst } from '../../../../src/shared/sidebar-list/sections/section-order'
import { withFolderWorkspacesLast } from './folder-workspace-lane-order'
import { prGroupOfPsLinkedPR } from '../../../../src/shared/sidebar-list/feed-facts/workspace-review-facts'
import {
  buildWorktreeOccurrencePlan,
  type WorktreeOccurrenceSection
} from '../../../../src/shared/sidebar-list/lineage/worktree-occurrence-plan'
import type { WorkspaceStatusDefinition } from '../../../../src/shared/worktree/types'
import {
  getWorkspaceStatus,
  getWorkspaceStatusGroupKey,
  withDefaultWorkspaceStatuses
} from '../../../../src/shared/workspace/status/workspace-statuses'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../src/shared/workspace/status/workspace-status-defaults'
import {
  getMobileOccurrenceRows,
  getMobileWorkspaceLineageChildren
} from '../agent-lineage/mobile-workspace-lineage'
import {
  getPRLaneKey,
  PR_GROUP_ORDER
} from '../../../../src/shared/workspace-view/workspace-pr-groups'
import type { FilterState, Section, SectionRepo, Worktree } from './workspace-list-types'
import type {
  WorkspaceGroupBy,
  WorkspaceSortBy
} from '../../../../src/shared/workspace-view/workspace-view-options'
import { hostSortsByStamps, sortWorktrees } from './workspace-list-ordering'
import { getWorktreeRowIdentity } from '../row-presentation/worktree-host-row-identity'
import { NO_WORKTREE_HOST_CONTEXT } from '../row-presentation/worktree-host-context-labels'
import type { WorktreeHostContextOf } from '../row-presentation/worktree-host-context-labels'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../src/shared/execution-host/execution-host'
import {
  buildProjectGroupingIndex,
  buildProjectSections,
  getProjectGroupingForRepo,
  type ProjectSectionModel
} from '../../../../src/shared/sidebar-list/sections/project-section-grouping'
import type { ProjectOrderBy } from '../../../../src/shared/ui-chrome/ui-chrome-types'
import type { Translate } from '../../i18n/mobile-i18n'
import {
  indexHiddenProjects,
  isRepoHidden,
  withoutHiddenFilterRepoIds
} from '../../../../src/shared/project/catalog/hidden-projects'
import { filterWorktrees, isPhoneRowInHiddenProject } from './workspace-row-filtering'
import { buildSectionRepoMap } from './section-repo-map'
import { keepHiddenRowsBelowFolders } from '../../../../src/shared/sidebar-list/folders/folder-workspace-occurrences'
import type { ProjectGroup } from '../../../../src/shared/project/groups/project-group-types'
import {
  placeInProjectGroupTree,
  planProjectGroupTree,
  bindGroupFolderRows,
  type GroupTreePlacement
} from '../project-sections/project-group-tree-sections'

export type ProjectSectionCatalog = {
  /** Catalog repos of the hosts the list shows; each without rows gets an empty section. */
  repos: readonly SectionRepo[]
  /** Null until the desktop's catalog answers; rows then group by repo, as the desktop's would. */
  grouping: ProjectSectionModel | null
  /** The desktop's project groups on the shown hosts; projects nest under them as in its sidebar. */
  projectGroups: readonly ProjectGroup[]
  /** Manual header rank; undefined keeps first-row order. */
  repoOrder: ReadonlyMap<string, number> | undefined
  projectOrderBy: ProjectOrderBy
}

export const NO_PROJECT_SECTION_CATALOG: ProjectSectionCatalog = {
  repos: [],
  grouping: null,
  projectGroups: [],
  repoOrder: undefined,
  projectOrderBy: 'manual'
}

// A section before lineage expansion: host rows only, no per-row view yet.
type PlannedSection = Omit<Section, 'data'> & { data: Worktree[] }

function makeSection(
  key: string,
  title: string,
  data: readonly Worktree[],
  decoration: { icon?: 'pin'; repo?: SectionRepo } = {}
): PlannedSection {
  return {
    key,
    title,
    ...(decoration.icon ? { icon: decoration.icon } : {}),
    ...(decoration.repo ? { repo: decoration.repo } : {}),
    data: [...data]
  }
}

export function isWorktreePinned(w: Worktree, localPins: Set<string>): boolean {
  return w.isPinned || localPins.has(w.worktreeId)
}

export function buildMobileWorkspacePlan(
  t: Translate,
  worktrees: Worktree[],
  sortMode: WorkspaceSortBy,
  filters: FilterState,
  search: string,
  groupMode: WorkspaceGroupBy,
  pinnedIds: Set<string>,
  projectCatalog: ProjectSectionCatalog = NO_PROJECT_SECTION_CATALOG,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = DEFAULT_WORKSPACE_STATUSES,
  _collapsedGroups: ReadonlySet<string> = new Set(),
  showPinnedInGroups = false,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId> = new Map(),
  lineageStores?: Parameters<typeof getMobileWorkspaceLineageChildren>[1]
) {
  const groupLabels = {
    pinned: t('worktree.workspaceListSections.pinned', 'Pinned'),
    all: t('worktree.workspaceListSections.all', 'All'),
    done: t('worktree.workspaceListSections.done', 'Done'),
    'in-review': t('worktree.workspaceListSections.inReview', 'In review'),
    'in-progress': t('worktree.workspaceListSections.inProgress', 'In progress'),
    closed: t('worktree.workspaceListSections.closed', 'Closed')
  }
  const hiddenProjects = indexHiddenProjects(projectCatalog.repos, LOCAL_EXECUTION_HOST_ID)
  const listedFilterIds = withoutHiddenFilterRepoIds(filters.filterRepoIds, hiddenProjects)
  const childrenByParentIdentity = getMobileWorkspaceLineageChildren(
    worktrees,
    lineageStores,
    listedFilterIds
  )
  const filtered = filterWorktrees(
    worktrees,
    filters,
    search,
    repoHostIdByRepoId,
    hiddenProjects,
    childrenByParentIdentity
  )
  const isHiddenRow = (w: Worktree) =>
    isPhoneRowInHiddenProject(w, repoHostIdByRepoId, hiddenProjects)
  const sorted = keepHiddenRowsBelowFolders({
    rows: sortWorktrees(filtered, sortMode, Date.now(), hostSortsByStamps(worktrees)),
    folderRows: filtered.filter((w) => w.workspaceKind === 'folder-workspace'),
    childrenByParentIdentity,
    identityOf: getWorktreeRowIdentity,
    isHidden: isHiddenRow
  })
  const repoMap = buildSectionRepoMap(projectCatalog.repos, worktrees, t)
  const projectIndex = buildProjectGroupingIndex(projectCatalog.grouping ?? undefined)
  let groupTreePlacements = new Map<string, GroupTreePlacement>()
  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: sorted,
    childrenByParentIdentity,
    identityOf: getWorktreeRowIdentity,
    isPinned: (worktree) => isWorktreePinned(worktree, pinnedIds),
    duplicatePinned: showPinnedInGroups,
    owningSectionOf: (worktree) =>
      getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex),
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural: canonicalGroupWorktrees, displayRootByIdentity }) => {
      const sections: PlannedSection[] = []
      if (pinned.length > 0) {
        sections.push(makeSection('pinned', groupLabels.pinned, pinned, { icon: 'pin' }))
      }
      if (groupMode === 'none') {
        if (canonicalGroupWorktrees.length > 0) {
          sections.push(
            makeSection('all', groupLabels.all, withFolderWorkspacesLast(canonicalGroupWorktrees))
          )
        }
      } else if (groupMode === 'repo') {
        const folderLane = bindGroupFolderRows(
          canonicalGroupWorktrees,
          projectCatalog.projectGroups,
          (w) => displayRootByIdentity.get(getWorktreeRowIdentity(w)) ?? w,
          childrenByParentIdentity,
          isHiddenRow
        )
        const representedRepoIds = new Set(worktrees.map((w) => w.repoId))
        const query = search.trim().toLowerCase()
        const placeholderRepoIds = projectCatalog.repos
          .filter(
            (repo) =>
              !representedRepoIds.has(repo.id) &&
              !isRepoHidden(repo) &&
              (listedFilterIds.length === 0 || listedFilterIds.includes(repo.id)) &&
              (!query || repo.displayName.toLowerCase().includes(query))
          )
          .map((repo) => repo.id)
        const projectSections = buildProjectSections({
          items: folderLane.projectRows,
          repoIdOf: (w) => w.repoId,
          displayRepoIdOf: (w) => folderLane.groupingRootOf(w).repoId,
          repoMap,
          projectIndex,
          placeholderRepoIds,
          repoOrder: projectCatalog.repoOrder,
          projectOrderBy: projectCatalog.projectOrderBy
        })
        const projectSection = ([
          key,
          { label, items, repo }
        ]: (typeof projectSections)[number]) => {
          const shown = items.filter((w) => !folderLane.bound.has(w))
          return {
            ...makeSection(key, label, orderMainWorktreeFirst(shown, sortMode), { repo }),
            ...(shown.length < items.length ? { count: items.length } : {})
          }
        }
        const tree = planProjectGroupTree({
          entries: projectSections,
          catalog: projectCatalog,
          folderRowsByGroupId: folderLane.folderRowsByGroupId,
          narrowed: query.length > 0,
          projectSection,
          groupSection: (key, title, rows) =>
            makeSection(key, title, withFolderWorkspacesLast(rows))
        })
        groupTreePlacements = tree.placements
        sections.push(...tree.sections)
      } else if (groupMode === 'workspace-status') {
        const renderableWorkspaceStatuses = withDefaultWorkspaceStatuses(workspaceStatuses)
        const byStatus = new Map<string, Worktree[]>()
        for (const w of canonicalGroupWorktrees) {
          const key = getWorkspaceStatus(w, renderableWorkspaceStatuses)
          const list = byStatus.get(key)
          if (list) {
            list.push(w)
          } else {
            byStatus.set(key, [w])
          }
        }
        for (const status of renderableWorkspaceStatuses) {
          const items = byStatus.get(status.id)
          if (items && items.length > 0) {
            sections.push(
              makeSection(
                getWorkspaceStatusGroupKey(status.id),
                // Status names are the host's (user-editable) labels, as on desktop.
                status.label,
                withFolderWorkspacesLast(items)
              )
            )
          }
        }
      } else if (groupMode === 'pr-status') {
        const byGroup = new Map<string, Worktree[]>()
        for (const w of canonicalGroupWorktrees) {
          const key = prGroupOfPsLinkedPR(w.linkedPR)
          const list = byGroup.get(key)
          if (list) {
            list.push(w)
          } else {
            byGroup.set(key, [w])
          }
        }
        for (const groupKey of PR_GROUP_ORDER) {
          const items = byGroup.get(groupKey)
          if (items && items.length > 0) {
            sections.push(
              makeSection(
                getPRLaneKey(groupKey),
                groupLabels[groupKey],
                withFolderWorkspacesLast(items)
              )
            )
          }
        }
      }
      return sections.map((section): PlannedSection & WorktreeOccurrenceSection<Worktree> => ({
        ...section,
        items: section.data,
        placement: section.key === 'pinned' ? 'pinned' : 'natural'
      }))
    }
  })
  return {
    occurrencePlan,
    render: (
      collapsed: ReadonlySet<string>,
      hostContextOf: WorktreeHostContextOf = NO_WORKTREE_HOST_CONTEXT
    ): Section[] =>
      occurrencePlan.sections.flatMap(({ items: _items, placement: _placement, ...section }) => {
        const listed = placeInProjectGroupTree(
          {
            ...section,
            data: getMobileOccurrenceRows(occurrencePlan, section.key, collapsed, hostContextOf)
          },
          groupTreePlacements.get(section.key),
          collapsed
        )
        return listed ? [listed] : []
      })
  }
}

export function buildSections(...args: Parameters<typeof buildMobileWorkspacePlan>): Section[] {
  return buildMobileWorkspacePlan(...args).render(args[9] ?? new Set())
}
