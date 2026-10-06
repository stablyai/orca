import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { worktreeSummaryReplySchema } from './worktree-metadata-reply-schema'

export type MobileWorktreeSummary = {
  readonly baseRef: string | null
  readonly linkedPR: number | null
}

/**
 * One reader for both worktree.show consumers. Branch compare read `worktree.baseRef` behind an
 * `isRecord` guard and the PR sidebar read `worktree.linkedPR` through optional chaining; both
 * yield null on the same inputs, so the fields merge without changing either answer.
 *
 * Total on purpose: both callers treat a missing summary as "no hint" and fall back to another
 * source, so a reply this cannot read is a null summary rather than an incompatible reply. The
 * schema is what turns a `baseRef` of the wrong type into that null instead of into a string the
 * branch-compare request would then send to the host.
 */
const worktreeSummarySchema: z.ZodType<MobileWorktreeSummary | null, unknown> =
  worktreeSummaryReplySchema
    .transform((value): MobileWorktreeSummary | null =>
      value.worktree
        ? { baseRef: value.worktree.baseRef ?? null, linkedPR: value.worktree.linkedPR ?? null }
        : null
    )
    .catch(null)

/** A refused show is a missing hint, not a failure: both callers fall back to another source. */
export const worktreeSummaryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.summary-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-summary', worktreeSummarySchema)
  })
)

/** Persisting a review link. The payload is unread; only acceptance matters. */
export const worktreeLinkSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-review-link',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('link-accepted', z.unknown())
  })
)
