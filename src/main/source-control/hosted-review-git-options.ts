import type { GitAdmissionTier } from '../../shared/rpc-contract/source-control/git-admission-tier-params'
import type { GhAccountBinding } from '../../shared/github/accounts/account-binding'

export type HostedReviewLocalGitOptions = {
  wslDistro?: string
  hostGit?: true
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
  ghAccount?: GhAccountBinding
}

export type HostedReviewExecutionOptions = {
  localGitExecOptions?: HostedReviewLocalGitOptions
  /** Configured Orca shared links are clean only when untracked real symlinks, never user files. */
  sharedLinkPaths?: readonly string[]
}

export function getHostedReviewLocalGitOptions(
  options: HostedReviewExecutionOptions = {}
): HostedReviewLocalGitOptions {
  const wslDistro = options.localGitExecOptions?.wslDistro
  const admissionTier = options.localGitExecOptions?.admissionTier
  const ghAccount = options.localGitExecOptions?.ghAccount
  const hostGit = options.localGitExecOptions?.hostGit
  const signal = options.localGitExecOptions?.signal
  return {
    ...(wslDistro ? { wslDistro } : {}),
    ...(hostGit ? { hostGit } : {}),
    ...(signal ? { signal } : {}),
    ...(admissionTier ? { admissionTier } : {}),
    ...(ghAccount ? { ghAccount } : {})
  }
}

export function hasHostedReviewLocalGitOptions(
  options: HostedReviewExecutionOptions = {}
): boolean {
  return Object.keys(getHostedReviewLocalGitOptions(options)).length > 0
}
