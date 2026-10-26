import type { RepoMethod } from '../../../shared/telemetry-events'
import { track } from '../../telemetry/client'
import { getCohortAtEmit } from '../../telemetry/cohort-classifier'

// Record the entry point and optional Git/folder classification; never paths, URLs or names.
export function emitRepoAdded(
  method: RepoMethod,
  alreadyExisted: boolean,
  isGitRepo?: boolean
): void {
  // Re-picking an existing repo is not a new activation.
  if (alreadyExisted) {
    return
  }
  // Read cohort after addRepo so it includes the newly added project.
  const props = {
    method,
    ...(isGitRepo === undefined ? {} : { is_git_repo: isGitRepo }),
    ...getCohortAtEmit()
  }
  track('repo_added', props)
}
