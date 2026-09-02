/** Structural shape both helpers need. Kept minimal so the Tasks route's own
 *  RepoSummary satisfies it without importing anything back. */
export type HostedRepoCandidate = {
  id: string
  kind?: string | null
}

/** Folder workspaces have no hosted provider behind them, so they cannot back a
 *  GitHub/GitLab task or a Project board row. */
export function isHostedTaskRepo(repo: HostedRepoCandidate): boolean {
  return repo.kind !== 'folder'
}

/** Narrows a persisted repo-id selection to what this host actually has.
 *  An empty result means "all repos", which is also what an empty persisted
 *  selection means, so a selection whose repos have all disappeared widens back
 *  out rather than silently matching nothing. */
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
