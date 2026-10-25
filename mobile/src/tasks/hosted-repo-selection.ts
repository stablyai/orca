export type HostedRepoCandidate = {
  id: string
  kind?: string | null
}

export function isHostedTaskRepo(repo: HostedRepoCandidate): boolean {
  return repo.kind !== 'folder'
}

// Empty selection means all repos; removing all stale selections must widen the filter rather than hide every row.
export function reconcileRepoSelection(
  repos: readonly HostedRepoCandidate[],
  persisted: readonly string[] | null | undefined
): Set<string> {
  if (!persisted || persisted.length === 0) {
    return new Set()
  }
  const availableIds = new Set(repos.filter(isHostedTaskRepo).map((repo) => repo.id))
  return new Set(persisted.filter((id) => availableIds.has(id)))
}
