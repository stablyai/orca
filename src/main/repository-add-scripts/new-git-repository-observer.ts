import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'

// Fires once the new Git Repo row is stored, not once its worktree root is prepared or ready.
// Evidence only: it never executes anything, and the row is a copy the observer may not rely on mutating.
export type NewGitRepositoryObserver = (repo: Repo) => void | PromiseLike<void>

// Internal: reports any row this call inserted, folder or Git, so a caller can tell it owns the row.
export type InsertedRepoObserver = (repo: Repo) => void

const OBSERVER_FAILED_WARNING = '[repository-registration] new-repository observer failed'

export function reportNewGitRepository(
  observer: NewGitRepositoryObserver | undefined,
  repo: Repo
): void {
  if (!observer || isFolderRepo(repo)) {
    return
  }
  // The error is dropped on purpose: a consumer failure may carry script text or paths.
  const warn = (): void => console.warn(OBSERVER_FAILED_WARNING)
  try {
    // A failing consumer must never turn a stored registration into an error.
    Promise.resolve(observer({ ...repo })).catch(warn)
  } catch {
    warn()
  }
}
