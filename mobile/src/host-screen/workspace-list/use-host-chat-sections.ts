import { useMemo } from 'react'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../../src/shared/repository/repo-host-identity'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { resolveWorktreeHostId } from '../../worktree/row-presentation/worktree-host-context-labels'
import {
  isLastVisitedWorktreeRow,
  type LastVisitedWorktreeOnHost
} from '../../worktree/row-presentation/host-list-highlight'
import { rowFiltersForView } from '../../worktree/workspace-list/workspace-view-settings'
import { NO_PROJECT_SECTION_CATALOG } from '../../worktree/workspace-list/workspace-list-sections'
import { useWorkspaceSections } from '../../worktree/use-workspace-sections'
import type {
  Section,
  SectionRepo,
  Worktree
} from '../../worktree/workspace-list/workspace-list-types'
import type { HostListSectionsInputs } from './use-host-list-sections'

const CHATS_GROUP_KEY = 'sidebar:chats'

export function useHostChatSections(
  inputs: HostListSectionsInputs,
  rows: Worktree[],
  repos: SectionRepo[],
  lastVisited: LastVisitedWorktreeOnHost | null
) {
  const t = useMobileTranslation()
  const { state } = inputs
  const collapsedGroups = useMemo(
    () => new Set(state.view.collapsedGroups),
    [state.view.collapsedGroups]
  )
  const catalog = useMemo(() => ({ ...NO_PROJECT_SECTION_CATALOG, repos }), [repos])
  const titledRows = useMemo(() => {
    const repoByKey = new Map(repos.map((repo) => [getRepoHostIdentity(repo), repo]))
    return rows.map((row) => {
      const repo = repoByKey.get(
        getRepoHostIdentityForParts(
          row.repoId,
          resolveWorktreeHostId(row, state.repoHostIdByRepoId)
        )
      )
      return repo && row.path === repo.path ? { ...row, displayName: repo.displayName } : row
    })
  }, [rows, repos, state.repoHostIdByRepoId])
  const filters = useMemo(() => rowFiltersForView(state.view), [state.view])
  const plan = useWorkspaceSections({
    displayWorktrees: titledRows,
    hostContextOf: inputs.hostContextOf,
    sortMode: state.view.sortBy,
    filters,
    search: state.search,
    groupMode: 'none',
    pinnedIds: state.pinnedIds,
    showPinnedInGroups: false,
    projectCatalog: catalog,
    filterCatalogRepos: repos,
    collapsedGroups,
    workspaceStatuses: state.view.workspaceStatuses,
    repoHostIdByRepoId: state.repoHostIdByRepoId
  })
  return useMemo(() => {
    const data = plan.rawSections
      .flatMap((section) => section.data)
      .map((item) => ({
        ...item,
        row: { ...item.row, isActive: isLastVisitedWorktreeRow(item.row, lastVisited) }
      }))
    const raw: Section[] =
      data.length || (repos.length && !state.search.trim())
        ? [
            {
              key: CHATS_GROUP_KEY,
              title: t('chats.title', 'Chats'),
              icon: 'chat',
              count: data.length,
              data
            }
          ]
        : []
    const collapsed = state.view.collapsedGroups.includes(CHATS_GROUP_KEY)
    return {
      rawSections: raw,
      sections: collapsed ? raw.map((section) => ({ ...section, data: [] })) : raw,
      repoById: plan.repoById
    }
  }, [
    plan.rawSections,
    plan.repoById,
    lastVisited,
    repos.length,
    state.search,
    state.view.collapsedGroups,
    t
  ])
}
