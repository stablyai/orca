import { useMemo } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { buildSidebarFeedRows } from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import { repoIconFeedKey } from '../../../src/shared/sidebar-list/repo-icon-data-urls-contract'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { RpcClient } from '../transport/rpc-client'
import { buildProjectSectionCatalog } from '../worktree/project-section-catalog'
import { useWorkspaceSections } from '../worktree/use-workspace-sections'
import { buildFilterRepos, type WorkspaceSectionRepo } from '../worktree/workspace-filter-repos'
import type { Section, SectionRepo, Worktree } from '../worktree/workspace-list-types'
import { useLastVisitedWorktreeOnHost } from '../worktree/use-last-visited-worktree-on-host'
import { rowFiltersForView } from '../worktree/workspace-view-settings'
import { buildSidebarFeedCatalog } from '../../../src/shared/sidebar-list/sidebar-feed-catalog'
import { buildHostFeedView } from './host-sidebar-feed-inputs'
import { buildHostFeedSections, buildPreFeedSections } from './host-sidebar-feed-sections'
import { useHostRepoIconDataUrls } from './use-host-repo-icon-data-urls'
import type { HostSidebarFeed } from './use-host-sidebar-feed'
import type { HostScreenState } from './use-host-screen-state'

export type HostListSectionsInputs = {
  client: RpcClient | null
  hostId: string | undefined
  /** Null in a build that lists without the feed. */
  feed: HostSidebarFeed | null
  displayWorktrees: Worktree[]
  /** The desktop's platform, which names its own host; never the phone's. */
  hostPlatform: NodeJS.Platform | null
  state: HostScreenState
}

export type HostListSections = {
  sections: Section[]
  rawSections: Section[]
  uniqueRepos: WorkspaceSectionRepo[]
  repoById: ReadonlyMap<string, SectionRepo>
  collapsedGroups: Set<string>
  projectOrderBy: ProjectOrderBy
}

function useCollapsedGroups(state: HostScreenState): Set<string> {
  return useMemo(() => new Set(state.view.collapsedGroups), [state.view.collapsedGroups])
}

function useFilterRepos(
  catalogRepos: readonly SectionRepo[],
  displayWorktrees: Worktree[]
): WorkspaceSectionRepo[] {
  return useMemo(
    () => buildFilterRepos(catalogRepos, displayWorktrees),
    [catalogRepos, displayWorktrees]
  )
}

function useLegacyHostListSections({
  displayWorktrees,
  state
}: HostListSectionsInputs): HostListSections {
  const projectCatalog = useMemo(
    () =>
      buildProjectSectionCatalog(
        state.servedProjectSections,
        state.desktopRepos,
        state.view.filters.visibleHostIds,
        state.view.projectOrderBy,
        state.view.personalProjectOrder
      ),
    [
      state.servedProjectSections,
      state.desktopRepos,
      state.view.filters.visibleHostIds,
      state.view.projectOrderBy,
      state.view.personalProjectOrder
    ]
  )
  const collapsedGroups = useCollapsedGroups(state)
  const rowFilters = useMemo(() => rowFiltersForView(state.view), [state.view])
  const sectionsResult = useWorkspaceSections({
    displayWorktrees,
    sortMode: state.view.sortBy,
    filters: rowFilters,
    search: state.search,
    groupMode: state.view.groupBy,
    pinnedIds: state.pinnedIds,
    showPinnedInGroups: state.showPinnedInGroups,
    projectCatalog,
    filterCatalogRepos: state.servedProjectSections?.repos ?? state.desktopRepos,
    collapsedGroups,
    workspaceStatuses: state.view.workspaceStatuses,
    repoHostIdByRepoId: state.repoHostIdByRepoId
  })
  return { ...sectionsResult, collapsedGroups, projectOrderBy: projectCatalog.projectOrderBy }
}

const NO_SECTIONS: Section[] = []

function useFeedHostListSections({
  client,
  hostId,
  feed,
  displayWorktrees,
  hostPlatform,
  state
}: HostListSectionsInputs): HostListSections {
  const collapsedGroups = useCollapsedGroups(state)
  const domains = feed?.kind === 'ready' ? feed.domains : null
  // The catalog installed with the rows; a desktop that predates it answers mobileRelay.projectSections.
  const served = domains?.projectCatalog ?? state.servedProjectSections
  const uniqueRepos = useFilterRepos(served?.repos ?? state.desktopRepos, displayWorktrees)
  const projectOrderBy = state.view.projectOrderBy ?? served?.projectOrderBy ?? 'manual'
  const catalog = useMemo(
    () => buildSidebarFeedCatalog(served, state.desktopRepos, state.hostProjectGroups),
    [served, state.desktopRepos, state.hostProjectGroups]
  )
  const view = useMemo(
    () =>
      buildHostFeedView({
        view: state.view,
        projectOrderBy,
        desktop: domains?.desktop ?? null,
        hostPlatform
      }),
    [state.view, projectOrderBy, domains, hostPlatform]
  )
  const built = useMemo(
    () => (domains ? buildSidebarFeedRows(domains, catalog, view) : null),
    [domains, catalog, view]
  )
  const lastVisited = useLastVisitedWorktreeOnHost(hostId)
  // Fall back only after an unreadable feed; before the first read, wait or retain the installed feed to avoid flashing a different list shape.
  const preFeed = feed?.kind === 'reopen'
  const sections = useMemo(
    () =>
      built
        ? buildHostFeedSections({
            rows: built.sectionRows,
            lastVisited,
            liveRows: displayWorktrees,
            repoHostIdByRepoId: state.repoHostIdByRepoId,
            search: state.search
          })
        : preFeed
          ? buildPreFeedSections({
              rows: displayWorktrees,
              view: state.view,
              search: state.search,
              repoHostIdByRepoId: state.repoHostIdByRepoId,
              lastVisited
            })
          : NO_SECTIONS,
    [
      built,
      preFeed,
      displayWorktrees,
      state.view,
      state.repoHostIdByRepoId,
      state.search,
      lastVisited
    ]
  )

  const iconIds = useMemo(() => [...new Set(domains?.repoIcons.values() ?? [])], [domains])
  const iconDataUrls = useHostRepoIconDataUrls(client, iconIds)
  const repoById = useMemo(() => {
    // The desktop's repo.list still carries uploads, which the served catalog withholds.
    const hostIcons = new Map(
      state.desktopRepos.map((repo) => [repoIconFeedKey(repo), repo.repoIcon])
    )
    const repos = served?.repos ?? state.desktopRepos
    return new Map(
      repos.map((repo) => {
        const key = repoIconFeedKey(repo)
        const iconId = domains?.repoIcons.get(key)
        const dataUrl = iconId ? iconDataUrls.get(iconId) : undefined
        const repoIcon = dataUrl
          ? { type: 'image', src: dataUrl }
          : (repo.repoIcon ?? hostIcons.get(key))
        return [repo.id, { ...repo, repoIcon }]
      })
    )
  }, [served, state.desktopRepos, domains, iconDataUrls])

  return { sections, rawSections: sections, uniqueRepos, repoById, collapsedGroups, projectOrderBy }
}

export const useHostListSections = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? useFeedHostListSections
  : useLegacyHostListSections
