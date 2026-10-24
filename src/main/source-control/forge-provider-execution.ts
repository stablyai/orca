import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  hasHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'
import type { ExecutionHostId } from '../../shared/execution-host'

/** The forge CLIs (`gh`, `glab`, the REST clients) run here; only their git reads are host-routed. */
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
