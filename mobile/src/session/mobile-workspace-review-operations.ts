import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export const renewWorkspaceReview = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.review.renew-or-skip',
    method: 'worktree.review.renew',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('review-renewed', z.object({ renewed: z.boolean() }))
  })
)

export const cachedWorkspaceReviewSchema = z.object({
  worktreeId: z.string(),
  linkedPR: z
    .object({
      state: z.enum(['open', 'merged', 'draft', 'closed', 'unknown']).catch('unknown'),
      checksStatus: z.enum(['success', 'failure', 'pending', 'neutral']).optional().catch(undefined)
    })
    .nullable()
})
