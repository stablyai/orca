import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  hasHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'
import type { ExecutionHostId } from '../../shared/execution-host/execution-host'

/** Forge CLIs/API clients run here; only their Git reads route to SSH. */
export function forgeConnectionId(context: { executionHostId: ExecutionHostId }): string | null {
  return hostedReviewSshConnectionId(context.executionHostId)
}

export function hostedReviewExecutionArgs(
  options: HostedReviewExecutionOptions
): [] | [HostedReviewExecutionOptions] {
  return hasHostedReviewLocalGitOptions(options)
    ? [{ localGitExecOptions: getHostedReviewLocalGitOptions(options) }]
    : []
}
