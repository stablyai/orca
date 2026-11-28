import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import {
  indexHiddenProjects,
  type HiddenProjects
} from '../../../../src/shared/project/catalog/hidden-projects'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import type { Repo } from '../../../../src/shared/repository/repo-types'
import type { HostScreenState } from '../use-host-screen-state'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { filterWorktreesForSearch } from '../../worktree/workspace-list/workspace-row-filtering'
import { getWorktreeRowIdentity } from '../../worktree/row-presentation/worktree-host-row-identity'
import { resolveWorktreeHostId } from '../../worktree/row-presentation/worktree-host-context-labels'
import { composeWorktreeHostIdentity } from '../../../../src/shared/worktree/host-qualified-identity'
import {
  rowFiltersForView,
  type MobileViewState
} from '../../worktree/workspace-list/workspace-view-settings'

export type HostFeedSearchHiddenRows = {
  /** Fed to the row plan as forced rows, so a search lists matches the filters hide. */
  forcedIdentities: readonly string[] | undefined
  /** The same identities; their rows get the Hidden tag. */
  filterHiddenIdentities: ReadonlySet<string>
}

const NONE: HostFeedSearchHiddenRows = {
  forcedIdentities: undefined,
  filterHiddenIdentities: new Set()
}

/** Search matches only the filters hide, by the rule the legacy list and desktop Cmd+J use. */
export function findHostFeedSearchHiddenRows(args: {
  rows: Worktree[]
  view: MobileViewState
  search: string
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
  hiddenProjects: HiddenProjects
  /** Rows the Bots section lists instead of their project; never forced into Projects. */
  botListedIdentities: ReadonlySet<string>
}): HostFeedSearchHiddenRows {
  if (!args.search.trim()) {
    return NONE
  }
  const { rows, filterHiddenIdentities } = filterWorktreesForSearch(
    args.rows,
    rowFiltersForView(args.view),
    args.search,
    args.repoHostIdByRepoId,
    args.hiddenProjects
  )
  const identities = new Set<string>()
  for (const row of rows) {
    if (!filterHiddenIdentities.has(getWorktreeRowIdentity(row))) {
      continue
    }
    const hostId = resolveWorktreeHostId(row, args.repoHostIdByRepoId)
    // A local feed row may keep a hostless identity (`|id`); force and tag both spellings.
    const spellings = [composeWorktreeHostIdentity(hostId, row.worktreeId)]
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      spellings.push(composeWorktreeHostIdentity(undefined, row.worktreeId))
    }
    if (!spellings.some((identity) => args.botListedIdentities.has(identity))) {
      spellings.forEach((identity) => identities.add(identity))
    }
  }
  return identities.size > 0
    ? { forcedIdentities: [...identities], filterHiddenIdentities: identities }
    : NONE
}

/** The host screen's search: filter-hidden matches for the feed-built row plan. */
export function useSearchHiddenRows(
  rows: Worktree[],
  state: Pick<HostScreenState, 'view' | 'search' | 'repoHostIdByRepoId'>,
  catalog: { repos: readonly Repo[] },
  botListedIdentities: ReadonlySet<string>
): HostFeedSearchHiddenRows {
  const { view, search, repoHostIdByRepoId } = state
  return useMemo(
    () =>
      findHostFeedSearchHiddenRows({
        rows,
        view,
        search,
        repoHostIdByRepoId,
        hiddenProjects: indexHiddenProjects(catalog.repos, LOCAL_EXECUTION_HOST_ID),
        botListedIdentities
      }),
    [rows, view, search, repoHostIdByRepoId, catalog.repos, botListedIdentities]
  )
}
