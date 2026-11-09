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
import { NO_WORKTREE_HOST_CONTEXT, resolveWorktreeHostId } from './worktree-host-context-labels'
import type { WorktreeHostContextOf } from './worktree-host-context-labels'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  buildProjectGroupingIndex,
  buildProjectSections,
  getProjectGroupingForRepo,
  type ProjectSectionModel
} from '../../../src/shared/project-section-grouping'
import { withRepoSectionDisplayLabels } from '../../../src/shared/project-section-order'
import {
  isSectionHiddenByCollapsedUmbrella,
  orderUmbrellaProjectSections
} from '../../../src/shared/sidebar-list/umbrella-subfolder-groups'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import {
  filterWorkspaceRows,
  type WorkspaceRowFactReader
} from '../../../src/shared/workspace-view/workspace-row-filters'
import { translate } from '../i18n/mobile-i18n'

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

// A section before lineage expansion: host rows only, no per-row view yet.
type PlannedSection = Omit<Section, 'data'> & { data: Worktree[] }

function makeSection(
  key: string,
  title: string,
  data: readonly Worktree[],
  decoration: Partial<PlannedSection> = {}
): PlannedSection {
  return { key, title, ...decoration, data: [...data] }
}

// Idle prompts have no recent output; live terminals or unread output still count as active.
export function isWorktreeActive(
  w: Pick<Worktree, 'hasHostSidebarActivity' | 'status' | 'liveTerminalCount'> & {
    unread?: boolean
  }
): boolean {
  return w.hasHostSidebarActivity !== undefined
    ? w.hasHostSidebarActivity
    : Boolean(w.unread) || (w.status ? w.status !== 'inactive' : w.liveTerminalCount > 0)
}

// Older hosts omit the main-worktree flag; use the legacy branch heuristic.
function guessDefaultBranchWorkspace(w: Worktree): boolean {
  return w.isMainWorktree !== undefined
    ? w.isMainWorktree && w.branch.trim() !== ''
    : /^refs\/heads\/(main|master)$|^(main|master)$/.test(w.branch)
}

function phoneRowFacts(
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): WorkspaceRowFactReader<Worktree> {
  return {
    isArchived: (w) => w.isArchived === true,
    isFolderWorkspace: (w) => w.workspaceKind === 'folder-workspace',
    repoId: (w) => w.repoId,
    hostId: (w) => resolveWorktreeHostId(w, repoHostIdByRepoId),
    isOtherClient: (w) => w.desktopOtherClient === true,
    isDefaultBranch: (w) => w.defaultBranch ?? guessDefaultBranchWorkspace(w),
    isAutomationCreated: (w) => w.automationCreated === true,
    isCliCreated: (w) => w.cliCreated === true,
    isDetachedHead: (w) => w.detachedHead === true,
    // Why the guess: #8873's exemption must fail open on hosts that predate isMainWorktree.
    isMainWorktree: (w) => w.isMainWorktree ?? guessDefaultBranchWorkspace(w),
    isSleeping: (w) => !isWorktreeActive(w)
  }
}

export function filterWorktrees(
  worktrees: Worktree[],
  filters: FilterState,
  search: string,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId> = new Map()
): Worktree[] {
  const result = filterWorkspaceRows(worktrees, filters, phoneRowFacts(repoHostIdByRepoId))
  const q = search.trim().toLowerCase()
  return !q
    ? result
    : result.filter((w) =>
        [w.displayName, w.branch, w.repo].some((s) => s.toLowerCase().includes(q))
      )
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
  const filtered = filterWorktrees(worktrees, filters, search, repoHostIdByRepoId)
  const sorted = sortWorktrees(filtered, sortMode, Date.now(), hostSortsByStamps(worktrees))
  const childrenByParentIdentity = getMobileWorkspaceLineageChildren(
    worktrees,
    lineageStores,
    filters.filterRepoIds
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
        const represented = new Set(worktrees.map((w) => w.repoId))
        const q = search.trim().toLowerCase()
        const filterSet = new Set(filters.filterRepoIds)
        const placeholderRepoIds = projectCatalog.repos
          .filter(
            (r) =>
              !represented.has(r.id) &&
              (filterSet.size === 0 || filterSet.has(r.id)) &&
              (!q || r.displayName.toLowerCase().includes(q))
          )
          .map((r) => r.id)
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
        for (const { key, section, decoration } of orderUmbrellaProjectSections(projectSections)) {
          sections.push(
            makeSection(
              key,
              section.label,
              orderMainWorktreeFirst(section.items, sortMode),
              decoration
            )
          )
        }
      } else if (groupMode === 'workspace-status') {
        const renderableWorkspaceStatuses = withDefaultWorkspaceStatuses(workspaceStatuses)
        const byStatus = new Map<string, Worktree[]>()
        for (const w of canonicalGroupWorktrees) {
          const key = getWorkspaceStatus(w, renderableWorkspaceStatuses)
          byStatus.set(key, [...(byStatus.get(key) ?? []), w])
        }
        for (const status of renderableWorkspaceStatuses) {
          const items = byStatus.get(status.id)
          if (items && items.length > 0) {
            sections.push(
              makeSection(
                getWorkspaceStatusGroupKey(status.id),
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
          byGroup.set(key, [...(byGroup.get(key) ?? []), w])
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
      occurrencePlan.sections
        .filter(
          (s) => !isSectionHiddenByCollapsedUmbrella(occurrencePlan.sections, s.key, collapsed)
        )
        .map(({ items: _items, placement: _placement, data: _data, ...section }) => {
          const rows = getMobileOccurrenceRows(
            occurrencePlan,
            section.key,
            collapsed,
            hostContextOf
          )
          return {
            ...section,
            data: section.projectGroupDepth
              ? rows.map((r) => ({
                  ...r,
                  view: { ...r.view, projectGroupDepth: section.projectGroupDepth }
                }))
              : rows
          }
        })
  }
}

export function buildSections(...args: Parameters<typeof buildMobileWorkspacePlan>): Section[] {
  return buildMobileWorkspacePlan(...args).render(args[8] ?? new Set())
}
