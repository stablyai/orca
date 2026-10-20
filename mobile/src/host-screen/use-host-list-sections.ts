import { useMemo } from 'react'
import { buildSidebarFeedRows } from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import { repoIconFeedKey } from '../../../src/shared/sidebar-list/repo-icon-data-urls-contract'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { RpcClient } from '../transport/rpc-client'
import { buildFilterRepos, type WorkspaceSectionRepo } from '../worktree/workspace-filter-repos'
import type { Section, SectionRepo, Worktree } from '../worktree/workspace-list-types'
import { useLastVisitedWorktreeOnHost } from '../worktree/use-last-visited-worktree-on-host'
import { buildSidebarFeedCatalog } from '../../../src/shared/sidebar-list/sidebar-feed-catalog'
import { buildHostFeedView } from './host-sidebar-feed-inputs'
import { buildHostFeedSections, buildPreFeedSections } from './host-sidebar-feed-sections'
import { useHostRepoIconDataUrls } from './use-host-repo-icon-data-urls'
import type { HostSidebarFeed } from './use-host-sidebar-feed'
import type { HostScreenState } from './use-host-screen-state'

export type HostListSectionsInputs = {
  client: RpcClient | null
  /** The paired host whose list this is. */
  hostId: string | undefined
  feed: HostSidebarFeed
  /** The rows worktree.ps and the desktop's server lists served, with display state applied. */
  displayWorktrees: Worktree[]
  /** The desktop's platform, which names its own host; never the phone's. */
  hostPlatform: NodeJS.Platform | null
  state: HostScreenState
}

export type HostListSections = {
  sections: Section[]
  uniqueRepos: WorkspaceSectionRepo[]
  /** Each row's repo by id, as the desktop's cards look theirs up for colour and icon. */
  repoById: ReadonlyMap<string, SectionRepo>
  collapsedGroups: Set<string>
  /** The desktop's value once read; the served catalog's (or the default) before. */
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

/** The desktop sidebar's own list, built by the shared builder from the host's feed. */
export function useHostListSections({
  client,
  hostId,
  feed,
  displayWorktrees,
  hostPlatform,
  state
}: HostListSectionsInputs): HostListSections {
  const collapsedGroups = useCollapsedGroups(state)
  const domains = feed.kind === 'ready' ? feed.domains : null
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
  const sections = useMemo(
    () =>
      built
        ? buildHostFeedSections({
            rows: built.sectionRows,
            activeRowKeys: built.activeRowKeys,
            lastVisited,
            liveRows: displayWorktrees,
            repoHostIdByRepoId: state.repoHostIdByRepoId,
            search: state.search
          })
        : // Before the first read, and under a feed this page cannot read, the rows it already holds.
          buildPreFeedSections({
            rows: displayWorktrees,
            view: state.view,
            search: state.search,
            repoHostIdByRepoId: state.repoHostIdByRepoId,
            lastVisited
          }),
    [built, displayWorktrees, state.view, state.repoHostIdByRepoId, state.search, lastVisited]
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

  return { sections, uniqueRepos, repoById, collapsedGroups, projectOrderBy }
}
