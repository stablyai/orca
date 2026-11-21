import {
  getTaskProjectPickerGroups,
  type TaskRepo
} from '../../../../src/shared/work-items/task-repo-selection'

export function isHostedTaskRepo(repo: Pick<TaskRepo, 'kind'>): boolean {
  return repo.kind !== 'folder'
}

/** The hosted repos a list reads: one per project, as desktop reads them, so a twin on another host doesn't list every item twice. Empty selection means all. */
export function listTaskSourceRepos<T extends TaskRepo>(
  repos: readonly T[],
  selection: ReadonlySet<string>
): T[] {
  const selected = repos.filter(
    (repo) => isHostedTaskRepo(repo) && (selection.size === 0 || selection.has(repo.id))
  )
  return getTaskProjectPickerGroups(selected).map((group) => group.repo)
}

// Empty selection means all repos; removing all stale selections must widen the filter rather than hide every row.
export function reconcileRepoSelection(
  repos: readonly TaskRepo[],
  persisted: readonly string[] | null | undefined
): Set<string> {
  if (!persisted || persisted.length === 0) {
    return new Set()
  }
  const availableIds = new Set(repos.filter(isHostedTaskRepo).map((repo) => repo.id))
  return new Set(persisted.filter((id) => availableIds.has(id)))
}
