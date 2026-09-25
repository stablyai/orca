import type { RepoMethod } from '../../../shared/telemetry-events'
import { track } from '../../telemetry/client'
import { getCohortAtEmit } from '../../telemetry/cohort-classifier'

// Why: `method` is the IPC entry point the user took, not what they added (never path/URL/name); repos:create → 'folder_picker'.
// Why: `isGitRepo` is a non-identifying git-vs-folder signal from the caller's detection; pass undefined when unknown, never default false.
// Why: it replaced onboarding_completed.is_git_repo, which lost meaning once repo selection left onboarding (1.4.46).
export function emitRepoAdded(
  method: RepoMethod,
  alreadyExisted: boolean,
  isGitRepo?: boolean
): void {
  // Why: re-adding an existing repo isn't a new activation; suppress so re-picking a folder doesn't inflate repo_added.
  if (alreadyExisted) {
    return
  }
  // Why: read cohort AFTER store.addRepo() so the just-added repo is counted (docs/onboarding-funnel-cohort-addendum.md §Read-vs-write ordering).
  const props = {
    method,
    ...(isGitRepo === undefined ? {} : { is_git_repo: isGitRepo }),
    ...getCohortAtEmit()
  }
  track('repo_added', props)
}
