import { useMemo } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../src/shared/sidebar-list/feed/sidebar-inputs-switch'
import { buildSidebarFeedRows } from '../../../../src/shared/sidebar-list/feed/sidebar-feed-rows'
import { repoIconFeedKey } from '../../../../src/shared/sidebar-list/catalog/repo-icon-data-urls-contract'
import type { ProjectOrderBy } from '../../../../src/shared/ui-chrome/ui-chrome-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { buildProjectSectionCatalog } from '../../worktree/project-sections/project-section-catalog'
import { useWorkspaceSections } from '../../worktree/use-workspace-sections'
import {
  buildFilterRepos,
  type WorkspaceSectionRepo
} from '../../worktree/repositories/workspace-filter-repos'
import type {
  Section,
  SectionRepo,
  Worktree
} from '../../worktree/workspace-list/workspace-list-types'
import type { WorktreeHostContextOf } from '../../worktree/row-presentation/worktree-host-context-labels'
import type { MobileLineageStores } from '../../worktree/agent-lineage/mobile-workspace-lineage'
import { useLastVisitedWorktreeOnHost } from '../../worktree/navigation/use-last-visited-worktree-on-host'
import { rowFiltersForView } from '../../worktree/workspace-list/workspace-view-settings'
import { buildSidebarFeedCatalog } from '../../../../src/shared/sidebar-list/catalog/sidebar-feed-catalog'
import { buildHostFeedView } from '../sidebar-feed/host-sidebar-feed-inputs'
import {
  buildHostFeedSections,
  buildPreFeedSections
} from '../sidebar-feed/host-sidebar-feed-sections'
import { useHostRepoIconDataUrls } from '../catalog/use-host-repo-icon-data-urls'
import type { HostSidebarFeed } from '../sidebar-feed/use-host-sidebar-feed'
import type { HostScreenState } from '../use-host-screen-state'
import {
  buildHostBotSections,
  isProjectListRow,
  type HostBotListing
} from '../../bots/host-bot-sections'
import { usePublishedBotStatuses } from '../../bots/use-published-bot-statuses'
import { useHostBotChatListInputs } from '../../bots/use-host-bot-chat-trees'
import { drawBotRow } from '../../bots/host-bot-row-draw'
import type { LastVisitedWorktreeOnHost } from '../../worktree/row-presentation/host-list-highlight'
import { indexHiddenProjects } from '../../../../src/shared/project/catalog/hidden-projects'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'

export type HostListSectionsInputs = {
  client: RpcClient | null
  hostId: string | undefined
  /** Null in a build that lists without the feed. */
  feed: HostSidebarFeed | null
  displayWorktrees: Worktree[]
  hostContextOf: WorktreeHostContextOf
  /** The desktop's platform, which names its own host; never the phone's. */
  hostPlatform: NodeJS.Platform | null
  /** The host's own store identity (status.get), for parents on another machine. */
  hostInstallationId: string | undefined
  /** The paired host's capabilities, which say whether it relays a server's reads. */
  hostCapabilities: readonly string[]
  state: HostScreenState
  /** Each host's bots, which lead the list in place of their folder rows. */
  bots: readonly HostBotListing[]
}

// What the list builders read beyond the screen's inputs: the rows the Bots sections take, and this phone's highlight.
type BaseListInputs = HostListSectionsInputs & {
  /** The host's rows before the Bots sections took theirs. */
  allHostRows: readonly Worktree[]
  botListedIdentities: ReadonlySet<string>
  lastVisited: LastVisitedWorktreeOnHost | null
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

/** The stores the host's list spans, by the identities the host checked. */
function useLineageStores({
  hostInstallationId,
  state
}: Pick<HostListSectionsInputs, 'hostInstallationId' | 'state'>): MobileLineageStores {
  return useMemo(
    () => ({ ownInstallationId: hostInstallationId, servers: state.serverWorkspaces.hosts }),
    [hostInstallationId, state.serverWorkspaces.hosts]
  )
}

function useLegacyHostListSections({
  displayWorktrees,
  allHostRows,
  hostContextOf,
  hostInstallationId,
  state
}: BaseListInputs): HostListSections {
  const projectCatalog = useMemo(
    () =>
      buildProjectSectionCatalog(
        state.servedProjectSections,
        state.desktopRepos,
        state.hostProjectGroups,
        state.view.filters.visibleHostIds,
        state.view.projectOrderBy,
        state.view.personalProjectOrder
      ),
    [
      state.servedProjectSections,
      state.desktopRepos,
      state.hostProjectGroups,
      state.view.filters.visibleHostIds,
      state.view.projectOrderBy,
      state.view.personalProjectOrder
    ]
  )
  const collapsedGroups = useCollapsedGroups(state)
  const rowFilters = useMemo(() => rowFiltersForView(state.view), [state.view])
  const lineageStores = useLineageStores({ hostInstallationId, state })
  const sectionsResult = useWorkspaceSections({
    displayWorktrees,
    allHostRows,
    hostContextOf,
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
    repoHostIdByRepoId: state.repoHostIdByRepoId,
    lineageStores
  })
  return { ...sectionsResult, collapsedGroups, projectOrderBy: projectCatalog.projectOrderBy }
}

const NO_SECTIONS: Section[] = []
const PHONE_FEED_LINEAGE = { acceptLegacyLineage: true }

function useFeedHostListSections({
  client,
  feed,
  displayWorktrees,
  hostContextOf,
  hostPlatform,
  state,
  botListedIdentities,
  lastVisited
}: BaseListInputs): HostListSections {
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
    // The phone keeps nesting by an older server's edges without instance ids, as it always has.
    () =>
      domains
        ? buildSidebarFeedRows(domains, catalog, view, {
            ...PHONE_FEED_LINEAGE,
            botListedWorktreeIdentities: botListedIdentities
          })
        : null,
    [domains, catalog, view, botListedIdentities]
  )
  // Fall back only after an unreadable feed; before the first read, wait or retain the installed feed to avoid flashing a different list shape.
  const preFeed = feed?.kind === 'reopen'
  const sections = useMemo(
    () =>
      built
        ? buildHostFeedSections({
            rows: built.sectionRows,
            lastVisited,
            liveRows: displayWorktrees,
            hostContextOf,
            repoHostIdByRepoId: state.repoHostIdByRepoId,
            search: state.search
          })
        : preFeed
          ? buildPreFeedSections({
              rows: displayWorktrees,
              hostContextOf,
              view: state.view,
              search: state.search,
              repoHostIdByRepoId: state.repoHostIdByRepoId,
              lastVisited,
              hiddenProjects: indexHiddenProjects(catalog.repos, LOCAL_EXECUTION_HOST_ID)
            })
          : NO_SECTIONS,
    [
      built,
      preFeed,
      catalog,
      displayWorktrees,
      hostContextOf,
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

const useBaseHostListSections = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? useFeedHostListSections
  : useLegacyHostListSections

export function useHostListSections(inputs: HostListSectionsInputs): HostListSections {
  const { bots, displayWorktrees, state } = inputs
  const collapsedGroups = useCollapsedGroups(state)
  const lastVisited = useLastVisitedWorktreeOnHost(inputs.hostId)
  const lineageStores = useLineageStores(inputs)
  const chatInputs = useHostBotChatListInputs({
    client: inputs.client,
    pairedHostId: inputs.hostId,
    hostCapabilities: inputs.hostCapabilities,
    listings: bots,
    collapsedGroups
  })
  const botSections = useMemo(
    () =>
      buildHostBotSections({
        rows: displayWorktrees,
        listings: bots,
        collapsedGroups,
        repoHostIdByRepoId: state.repoHostIdByRepoId,
        search: state.search,
        drawRow: drawBotRow(lastVisited),
        lineageStores,
        ...chatInputs
      }),
    [
      displayWorktrees,
      bots,
      collapsedGroups,
      state.repoHostIdByRepoId,
      state.search,
      lastVisited,
      lineageStores,
      chatInputs
    ]
  )
  usePublishedBotStatuses(inputs.hostId, bots, botSections.sections)
  // Left out before the list is planned, as the desktop's are, so counts and empty sections follow its rules.
  const listRows = useMemo(
    () =>
      botSections.listedIdentities.size === 0
        ? displayWorktrees
        : displayWorktrees.filter((row) =>
            isProjectListRow(row, botSections.listedIdentities, state.repoHostIdByRepoId)
          ),
    [displayWorktrees, botSections, state.repoHostIdByRepoId]
  )
  const base = useBaseHostListSections({
    ...inputs,
    displayWorktrees: listRows,
    allHostRows: displayWorktrees,
    botListedIdentities: botSections.listedIdentities,
    lastVisited
  })
  return useMemo(() => {
    if (botSections.sections.length === 0) {
      return base
    }
    return {
      ...base,
      sections: [...botSections.sections, ...base.sections],
      rawSections: [...botSections.sections, ...base.rawSections]
    }
  }, [base, botSections])
}
