import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import type { GhAccountBinding } from '../../shared/github/account-binding'

export type HostedReviewLocalGitOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  ghAccount?: GhAccountBinding
  resolveGitHubAccount?: () => GhAccountBinding | undefined
  canStart?: () => boolean
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
  const resolveGitHubAccount = options.localGitExecOptions?.resolveGitHubAccount
  const canStart = options.localGitExecOptions?.canStart
  return {
    ...(wslDistro ? { wslDistro } : {}),
    ...(admissionTier ? { admissionTier } : {}),
    ...(ghAccount ? { ghAccount } : {}),
    ...(resolveGitHubAccount ? { resolveGitHubAccount } : {}),
    ...(canStart ? { canStart } : {})
  }
}

export function resolveHostedReviewGitHubOptions(
  options: HostedReviewExecutionOptions = {}
): HostedReviewLocalGitOptions {
  const { resolveGitHubAccount, ghAccount, canStart, ...gitOptions } =
    getHostedReviewLocalGitOptions(options)
  const binding = resolveGitHubAccount ? resolveGitHubAccount() : ghAccount
  const checkStart = resolveGitHubAccount
    ? () => {
        if (canStart?.() === false) {
          return false
        }
        resolveGitHubAccount()
        return true
      }
    : canStart
  return {
    ...gitOptions,
    ...(binding ? { ghAccount: binding } : {}),
    ...(checkStart ? { canStart: checkStart } : {})
  }
}

export function hasHostedReviewLocalGitOptions(
  options: HostedReviewExecutionOptions = {}
): boolean {
  return Object.keys(getHostedReviewLocalGitOptions(options)).length > 0
}
