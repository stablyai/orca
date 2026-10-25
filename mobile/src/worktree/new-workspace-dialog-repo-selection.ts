type ExecutionHostScope = 'all' | 'local' | `ssh:${string}` | `runtime:${string}`

type MobileNewWorkspaceDialogRepo = {
  id: string
  path: string
  connectionId?: string | null
  executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
}

export function getMobileNewWorkspaceDialogEligibleRepos<T extends { path: string }>(
  repos: readonly T[]
): T[] {
  return repos.filter((repo) => Boolean(repo.path))
}

function getMobileRepoExecutionHostId(
  repo: MobileNewWorkspaceDialogRepo
): Exclude<ExecutionHostScope, 'all'> {
  if (repo.executionHostId) {
    return repo.executionHostId
  }
  return repo.connectionId ? `ssh:${encodeURIComponent(repo.connectionId)}` : 'local'
}

export function resolveMobileNewWorkspaceDialogRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: {
  eligibleRepos: readonly MobileNewWorkspaceDialogRepo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  // Metro cannot bundle this root runtime import; mirror src/shared/new-workspace-dialog-repo.ts.
  const focusedHostRepo =
    focusedHostScope && focusedHostScope !== 'all'
      ? eligibleRepos.find((repo) => getMobileRepoExecutionHostId(repo) === focusedHostScope)
      : undefined

  const resolvedRepo =
    (draftRepoId && eligibleRepos.find((repo) => repo.id === draftRepoId)) ||
    (initialRepoId && eligibleRepos.find((repo) => repo.id === initialRepoId)) ||
    (activeRepoId && eligibleRepos.find((repo) => repo.id === activeRepoId)) ||
    focusedHostRepo ||
    eligibleRepos[0]

  return resolvedRepo?.id ?? ''
}

// Repo ids are unique per host, not globally.
export function isSameMobileWorkspaceRepo(
  a: MobileNewWorkspaceDialogRepo,
  b: MobileNewWorkspaceDialogRepo
): boolean {
  return a.id === b.id && getMobileRepoExecutionHostId(a) === getMobileRepoExecutionHostId(b)
}

export function refreshMobileNewWorkspaceDialogSelectedRepo<T extends MobileNewWorkspaceDialogRepo>(
  repos: readonly T[],
  current: T | null
): T | null {
  if (!current) {
    return null
  }
  return repos.find((repo) => isSameMobileWorkspaceRepo(repo, current)) ?? null
}
