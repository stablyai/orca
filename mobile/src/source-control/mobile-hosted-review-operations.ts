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

/**
 * Eligibility is advisory: when the host cannot answer, mobile fails closed on its own rather
 * than treating the refusal as an error, so refusal is a skip.
 */
export const hostedReviewEligibilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'hostedReview.creation-eligibility-or-skip',
    method: 'hostedReview.getCreationEligibility',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('creation-eligibility', hostedReviewEligibilitySchema)
  })
)

/**
 * Creation answers in-band too: an accepted reply can carry `ok: false` plus an existing review.
 * Two variants rather than one schema because the host's own result is a discriminated union and
 * the arms require different members; the success arm is declared first so a reply carrying both
 * `ok: true` and a stray `error` reads as the success it is.
 */
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
