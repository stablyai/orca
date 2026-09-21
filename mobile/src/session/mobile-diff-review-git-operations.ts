import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { reviewGitMutationSchema } from './diff-review-reply-schema'
import type { GitMutationMethod } from './mobile-diff-review-screen-model'

// The three file-level git mutations the review screen runs. Each is its own operation because an
// operation fixes its method; the screen picks between them by the action the user tapped.

/**
 * Two policies over the same three methods, because the screen means two different things by them.
 *
 * A single-file action is one thing the user asked for, so a refusal is raised with the host's own
 * message and the screen shows it. "Stage all reviewed" is a loop over many files that reports a
 * count, so each refusal is counted rather than raised — one locked file must not abandon the rest.
 */
function reviewGitMutation(name: string, method: GitMutationMethod) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant('review-git-mutation', reviewGitMutationSchema)
    })
  )
}

export const reviewGitStage = reviewGitMutation('git.review-stage', 'git.stage')
export const reviewGitUnstage = reviewGitMutation('git.review-unstage', 'git.unstage')
export const reviewGitDiscard = reviewGitMutation('git.review-discard', 'git.discard')

/** The bulk arm's `git.stage`: a refused file is a tally entry, never the end of the sweep. */
export const reviewGitStageRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-stage-reviewed-or-skip',
    method: 'git.stage',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('review-git-mutation', reviewGitMutationSchema)
  })
)

export const MOBILE_DIFF_REVIEW_GIT_MUTATIONS = {
  'git.stage': reviewGitStage,
  'git.unstage': reviewGitUnstage,
  'git.discard': reviewGitDiscard
} as const satisfies Record<GitMutationMethod, unknown>
