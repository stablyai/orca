import { useMemo } from 'react'
import type { WorkspaceStatusDefinition } from '../../../src/shared/types'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'
import {
  buildSections,
  type FilterState,
  type Section,
  type Worktree
} from './workspace-list-sections'
import { repoColor } from './repo-color'

export type WorkspaceSectionRepo = {
  name: string
  id: string
  color: string
}

export function useWorkspaceSections(args: {
  displayWorktrees: Worktree[]
  sortMode: MobileSortMode
  filters: FilterState
  search: string
  groupMode: MobileGroupMode
  pinnedIds: Set<string>
  repoIdsByName: Map<string, string>
  repoColorsByName: Map<string, string>
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): {
  sections: Section[]
  rawSections: Section[]
  uniqueRepos: WorkspaceSectionRepo[]
  uniqueRepoColors: Map<string, string>
} {
  const {
    displayWorktrees,
    sortMode,
    filters,
    search,
    groupMode,
    pinnedIds,
    repoIdsByName,
    repoColorsByName,
    collapsedGroups,
    workspaceStatuses
  } = args

  const uniqueRepos = useMemo(() => {
    const repos = new Map<string, { id: string; color: string }>()
    for (const w of displayWorktrees) {
      if (!repos.has(w.repo)) {
        repos.set(w.repo, {
          id: repoIdsByName.get(w.repo) ?? w.repoId,
          color: repoColorsByName.get(w.repo) ?? repoColor(w.repo)
        })
      }
    }
    return [...repos.entries()].map(([name, { id, color }]) => ({ name, id, color }))
  }, [displayWorktrees, repoColorsByName, repoIdsByName])

  const uniqueRepoColors = useMemo(
    () => new Map(uniqueRepos.map((repo) => [repo.name, repo.color])),
    [uniqueRepos]
  )

  const rawSections = useMemo(
    () =>
      buildSections(
        displayWorktrees,
        sortMode,
        filters,
        search,
        groupMode,
        pinnedIds,
        repoIdsByName,
        workspaceStatuses,
        collapsedGroups
      ),
    [
      displayWorktrees,
      sortMode,
      filters,
      search,
      groupMode,
      pinnedIds,
      repoIdsByName,
      workspaceStatuses,
      collapsedGroups
    ]
  )

  const sections = useMemo(
    () =>
      rawSections.map((s) => ({
        ...s,
        data: collapsedGroups.has(s.key) ? [] : s.data
      })),
    [rawSections, collapsedGroups]
  )

  return { sections, rawSections, uniqueRepos, uniqueRepoColors }
}
