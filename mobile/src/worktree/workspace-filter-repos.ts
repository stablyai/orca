import {
  buildProjectGroupingIndex,
  type ProjectSectionModel,
  type ProjectGroupingIndex
} from '../../../src/shared/project-section-grouping'
import {
  getProjectRepoFilterHost,
  projectFilterSelection,
  editProjectFilter,
  type ProjectFilterSelection
} from '../../../src/shared/project-repo-filter-selection'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { resolveRepoBadgeColor } from '../../../src/shared/repo-badge-color'
import { buildSectionRepoMap, type SectionRepo, type Worktree } from './workspace-list-sections'

export type WorkspaceSectionRepo = {
  /** Unique per host: two hosts can each hold a repo of the same name. */
  key: string
  name: string
  id: string
  color: string
  grouping?: ProjectGroupingIndex
}

export function sectionRepoColor(repo: Pick<SectionRepo, 'badgeColor'>): string {
  return resolveRepoBadgeColor(repo.badgeColor)
}

// List catalog repos per host; before catalogs arrive, derive candidates from workspace rows.
export function buildFilterRepos(
  filterCatalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[],
  grouping?: ProjectSectionModel | null
): WorkspaceSectionRepo[] {
  const repos =
    filterCatalogRepos.length > 0
      ? filterCatalogRepos
      : [...buildSectionRepoMap([], worktrees).values()]
  if (grouping) {
    const index = buildProjectGroupingIndex(grouping)
    const repoByHost = new Map(
      repos.map((repo) => [`${getProjectRepoFilterHost(repo)}\0${repo.id}`, repo])
    )
    return index.groups.flatMap((group) => {
      const setup = group.representative
      const repo = repoByHost.get(`${getProjectRepoFilterHost(setup)}\0${setup.repoId}`)
      return repo
        ? [
            {
              key: group.key,
              id: group.key,
              name: group.label,
              color: sectionRepoColor(repo),
              grouping: index
            }
          ]
        : []
    })
  }
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    const key = `${getProjectRepoFilterHost(repo)}|${repo.id}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}

const filterIndexes = new WeakMap<readonly WorkspaceSectionRepo[], ProjectGroupingIndex>()

export function workspaceProjectFilterSelection(
  repos: readonly WorkspaceSectionRepo[],
  selected: readonly string[],
  meaning: 'exact' | 'legacy' = 'exact'
): ProjectFilterSelection {
  const index = workspaceProjectFilterIndex(repos)
  if (meaning === 'exact') {
    return projectFilterSelection(index, selected)
  }
  const ids = new Set(selected)
  const fullKeys = repos.filter((repo) => ids.has(repo.id)).map((repo) => repo.key)
  const full = new Set(fullKeys)
  return {
    active: selected.length > 0,
    fullKeys,
    partialKeys: [],
    matchingKeys: fullKeys,
    full,
    partial: new Set(),
    matching: full,
    unresolved: selected.filter((id) => !index.setupByRepoId.has(id)),
    badgeCount: selected.length ? Math.max(1, fullKeys.length) : 0
  }
}

function workspaceProjectFilterIndex(repos: readonly WorkspaceSectionRepo[]): ProjectGroupingIndex {
  const cached = filterIndexes.get(repos)
  if (cached) {
    return cached
  }
  const ownerIndex = repos.find((repo) => repo.grouping)?.grouping
  if (ownerIndex) {
    filterIndexes.set(repos, ownerIndex)
    return ownerIndex
  }
  const index = buildProjectGroupingIndex({
    projects: repos.map((repo) => ({ id: repo.key, displayName: repo.name })),
    projectHostSetups: repos.map((repo) => ({
      id: repo.key,
      projectId: repo.key,
      repoId: repo.id,
      groupKey: repo.key,
      hostId: normalizeExecutionHostId(repo.key.slice(0, repo.key.lastIndexOf('|'))) ?? 'local',
      path: '',
      displayName: repo.name,
      setupMethod: 'legacy-repo'
    }))
  })
  filterIndexes.set(repos, index)
  return index
}

export function selectedWorkspaceProjectKeys(
  repos: readonly WorkspaceSectionRepo[],
  selected: readonly string[]
): ReadonlySet<string> {
  return workspaceProjectFilterSelection(repos, selected).full
}

export function toggleProjectFilter(
  repo: WorkspaceSectionRepo,
  selected: readonly string[],
  repos: readonly WorkspaceSectionRepo[] = [repo],
  meaning: 'exact' | 'legacy' = 'exact'
): string[] {
  if (meaning === 'legacy') {
    return selected.includes(repo.id)
      ? selected.filter((id) => id !== repo.id)
      : [...selected, repo.id]
  }
  const index = workspaceProjectFilterIndex(repos)
  return editProjectFilter(index, selected, {
    kind: projectFilterSelection(index, selected).full.has(repo.key) ? 'remove' : 'complete',
    keys: [repo.key]
  })
}
