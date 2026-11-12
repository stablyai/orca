import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import type { GhAccountBinding } from '../../shared/github/accounts/account-binding'

export type HostedReviewLocalGitOptions = {
  wslDistro?: string
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
  return {
    ...(wslDistro ? { wslDistro } : {}),
    ...(admissionTier ? { admissionTier } : {}),
    ...(ghAccount ? { ghAccount } : {})
  }
}

export function hasHostedReviewLocalGitOptions(
  options: HostedReviewExecutionOptions = {}
): boolean {
  return Object.keys(getHostedReviewLocalGitOptions(options)).length > 0
}
