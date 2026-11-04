import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant, rpcResultVariants } from '../transport/rpc-operation-result-reader'
import {
  hostedReviewCreateFailedSchema,
  hostedReviewCreateOkSchema,
  hostedReviewEligibilitySchema,
  type MobileHostedReviewCreateFailed,
  type MobileHostedReviewCreateOk
} from './hosted-review-reply-schema'

export type MobileHostedReviewCreateReply =
  | MobileHostedReviewCreateOk
  | MobileHostedReviewCreateFailed

// Eligibility is advisory; skip refusal and let mobile fail closed.
export const hostedReviewEligibilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'hostedReview.creation-eligibility-or-skip',
    method: 'hostedReview.getCreationEligibility',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('creation-eligibility', hostedReviewEligibilitySchema)
  })
)

// Accepted creation may fail in-band; put success first so a stray error cannot override ok: true.
export const hostedReviewCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'hostedReview.create',
    method: 'hostedReview.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariants<'create-succeeded' | 'create-refused', MobileHostedReviewCreateReply>([
      rpcResultVariant('create-succeeded', hostedReviewCreateOkSchema),
      rpcResultVariant('create-refused', hostedReviewCreateFailedSchema)
    ])
  })
)
