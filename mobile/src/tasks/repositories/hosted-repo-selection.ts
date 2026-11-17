import {
  getTaskProjectPickerGroups,
  type TaskRepo
} from '../../../../src/shared/work-items/task-repo-selection'

export function isHostedTaskRepo(repo: Pick<TaskRepo, 'kind'>): boolean {
  return repo.kind !== 'folder'
}

/** One hosted repo per project, as desktop lists them, so a repo's twin on another host doesn't list every item twice. */
export function listTaskSourceRepos<T extends TaskRepo>(
  repos: readonly T[],
  selection: ReadonlySet<string>
): T[] {
  return getTaskProjectPickerGroups(repos.filter(isHostedTaskRepo), selection).map(
    (group) => group.repo
  )
}

// Empty selection means all repos; removing all stale selections must widen the filter rather than hide every row.
export function reconcileRepoSelection(
  repos: readonly TaskRepo[],
  persisted: readonly string[] | null | undefined
): Set<string> {
  if (!persisted || persisted.length === 0) {
    return new Set()
  }
  const availableIds = new Set(
    listTaskSourceRepos(repos, new Set(persisted)).map((repo) => repo.id)
  )
  return new Set(persisted.filter((id) => availableIds.has(id)))
}
