import { getRepoExecutionHostId } from '../../../src/shared/execution-host'

type MobileNewWorkspaceDialogRepo = {
  id: string
  connectionId?: string | null
  executionHostId?: string | null
}

// Repo ids are unique per host, not globally.
export function isSameMobileWorkspaceRepo(
  a: MobileNewWorkspaceDialogRepo,
  b: MobileNewWorkspaceDialogRepo
): boolean {
  return a.id === b.id && getRepoExecutionHostId(a) === getRepoExecutionHostId(b)
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
