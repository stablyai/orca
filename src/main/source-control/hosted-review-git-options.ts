import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

export type HostedReviewLocalGitOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

export type HostedReviewExecutionOptions = {
  localGitExecOptions?: HostedReviewLocalGitOptions
  /** Paths Orca may have symlinked into this worktree. An untracked entry that
   *  is one of these is Orca's own artifact, not work the user can commit, so it
   *  must not read as "dirty" and block review creation. */
  sharedLinkPaths?: readonly string[]
}

export function getHostedReviewLocalGitOptions(
  options: HostedReviewExecutionOptions = {}
): HostedReviewLocalGitOptions {
  const wslDistro = options.localGitExecOptions?.wslDistro
  const admissionTier = options.localGitExecOptions?.admissionTier
  return {
    ...(wslDistro ? { wslDistro } : {}),
    ...(admissionTier ? { admissionTier } : {})
  }
}

export function hasHostedReviewLocalGitOptions(
  options: HostedReviewExecutionOptions = {}
): boolean {
  return Object.keys(getHostedReviewLocalGitOptions(options)).length > 0
}
