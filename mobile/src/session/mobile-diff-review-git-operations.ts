import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { reviewGitMutationSchema } from './diff-review-reply-schema'
import type { GitMutationMethod } from './mobile-diff-review-screen-model'

// Single-file refusals surface host text; bulk stage tallies failures and continues so one locked file cannot abort the sweep.
function reviewGitMutation(name: string, method: GitMutationMethod | 'git.bulkUnstage') {
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
export const reviewGitBulkUnstage = reviewGitMutation('git.review-bulk-unstage', 'git.bulkUnstage')
export const reviewGitDiscard = reviewGitMutation('git.review-discard', 'git.discard')

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
