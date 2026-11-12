import { orderMainWorktreeFirst } from '../../../src/shared/sidebar-list/section-order'
import { withFolderWorkspacesLast } from './folder-workspace-lane-order'
import { prGroupOfPsLinkedPR } from '../../../src/shared/sidebar-list/workspace-review-facts'
import {
  buildWorktreeOccurrencePlan,
  type WorktreeOccurrenceSection
} from '../../../src/shared/worktree-occurrence-plan'
import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import {
  DEFAULT_WORKSPACE_STATUSES,
  getWorkspaceStatus,
  getWorkspaceStatusGroupKey,
  withDefaultWorkspaceStatuses
} from '../../../src/shared/workspace-statuses'
import {
  getMobileOccurrenceRows,
  getMobileWorkspaceLineageChildren
} from './mobile-workspace-lineage'
import {
  getPRLaneKey,
  PR_GROUP_ORDER
} from '../../../src/shared/workspace-view/workspace-pr-groups'
import type { FilterState, Section, SectionRepo, Worktree } from './workspace-list-types'
import type {
  WorkspaceGroupBy,
  WorkspaceSortBy
} from '../../../src/shared/workspace-view/workspace-view-options'
import { hostSortsByStamps, sortWorktrees } from './workspace-list-ordering'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'
import { NO_WORKTREE_HOST_CONTEXT } from './worktree-host-context-labels'
import type { WorktreeHostContextOf } from './worktree-host-context-labels'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../src/shared/execution-host'
import {
  buildProjectGroupingIndex,
  buildProjectSections,
  getProjectGroupingForRepo,
  type ProjectSectionModel
} from '../../../src/shared/project-section-grouping'
import { withRepoSectionDisplayLabels } from '../../../src/shared/project-section-order'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import { translate } from '../i18n/mobile-i18n'
import {
  indexHiddenProjects,
  isRepoHidden,
  withoutHiddenFilterRepoIds
} from '../../../src/shared/hidden-projects'
import { filterWorktrees } from './workspace-row-filtering'

export type { FilterState, Section, SectionRepo, Worktree } from './workspace-list-types'

export type ProjectSectionCatalog = {
  /** Catalog repos of the hosts the list shows; each without rows gets an empty section. */
  repos: readonly SectionRepo[]
  /** Null until the desktop's catalog answers; rows then group by repo, as the desktop's would. */
  grouping: ProjectSectionModel | null
  /** Manual header rank; undefined keeps first-row order. */
  repoOrder: ReadonlyMap<string, number> | undefined
  projectOrderBy: ProjectOrderBy
}

export const NO_PROJECT_SECTION_CATALOG: ProjectSectionCatalog = {
  repos: [],
  grouping: null,
  repoOrder: undefined,
  projectOrderBy: 'manual'
}

export function buildSectionRepoMap(
  catalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[]
): Map<string, SectionRepo> {
  const repoMap = new Map(catalogRepos.map((repo) => [repo.id, repo]))
  for (const w of worktrees) {
    if (!repoMap.has(w.repoId)) {
      repoMap.set(w.repoId, {
        id: w.repoId,
        displayName: w.repo || translate('common.unknown', 'Unknown'),
        // Why: labels key on host + path, so a shared '' would let one stand-in rename another.
        path: w.repoId,
        executionHostId: w.hostId
      })
    }
  }
  return repoMap
}
export { getWorktreeStatus, sortWorktrees } from './workspace-list-ordering'
export { filterWorktrees, isWorktreeActive } from './workspace-row-filtering'

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
    pinned: translate('worktree.workspaceListSections.pinned', 'Pinned'),
    all: translate('worktree.workspaceListSections.all', 'All'),
    done: translate('worktree.workspaceListSections.done', 'Done'),
    'in-review': translate('worktree.workspaceListSections.inReview', 'In review'),
    'in-progress': translate('worktree.workspaceListSections.inProgress', 'In progress'),
    closed: translate('worktree.workspaceListSections.closed', 'Closed')
  }
  const hiddenProjects = indexHiddenProjects(projectCatalog.repos, LOCAL_EXECUTION_HOST_ID)
  const filtered = filterWorktrees(worktrees, filters, search, repoHostIdByRepoId, hiddenProjects)
  const listedFilterIds = withoutHiddenFilterRepoIds(filters.filterRepoIds, hiddenProjects)
  const sorted = sortWorktrees(filtered, sortMode, Date.now(), hostSortsByStamps(worktrees))
  const childrenByParentIdentity = getMobileWorkspaceLineageChildren(
    worktrees,
    lineageStores,
    listedFilterIds
  )
  const repoMap = buildSectionRepoMap(projectCatalog.repos, worktrees)
  const projectIndex = buildProjectGroupingIndex(projectCatalog.grouping ?? undefined)
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
        const projectSections = withRepoSectionDisplayLabels(
          buildProjectSections({
            items: canonicalGroupWorktrees,
            repoIdOf: (w) => w.repoId,
            displayRepoIdOf: (w) =>
              (displayRootByIdentity.get(getWorktreeRowIdentity(w)) ?? w).repoId,
            repoMap,
            projectIndex,
            placeholderRepoIds,
            repoOrder: projectCatalog.repoOrder,
            projectOrderBy: projectCatalog.projectOrderBy
          })
        )
        for (const [key, section] of projectSections) {
          sections.push(
            makeSection(key, section.label, orderMainWorktreeFirst(section.items, sortMode), {
              repo: section.repo
            })
          )
        }
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
      occurrencePlan.sections.map((section) => ({
        key: section.key,
        title: section.title,
        ...(section.icon ? { icon: section.icon } : {}),
        ...(section.repo ? { repo: section.repo } : {}),
        data: getMobileOccurrenceRows(occurrencePlan, section.key, collapsed, hostContextOf)
      }))
  }
}

export function buildSections(...args: Parameters<typeof buildMobileWorkspacePlan>): Section[] {
  return buildMobileWorkspacePlan(...args).render(args[8] ?? new Set())
}
