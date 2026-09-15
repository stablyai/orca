import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

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
    read: rpcUncheckedPayloadReader('creation-eligibility')
  })
)

/** Creation answers in-band too: an accepted reply can carry `ok: false` plus an existing review. */
export const hostedReviewCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'hostedReview.create',
    method: 'hostedReview.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('create-result')
  })
)
