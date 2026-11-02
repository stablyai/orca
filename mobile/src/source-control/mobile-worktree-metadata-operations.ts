import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { GitPushTarget } from '../../../src/shared/worktree/types'
import { worktreeSummaryReplySchema } from './worktree-metadata-reply-schema'

export type MobileWorktreeSummary = {
  readonly baseRef: string | null
  readonly linkedPR: number | null
  readonly suppressedGitHubPR: number | null
  readonly pushTarget: GitPushTarget | null
  // Guard a stale-link clear against a worktree that moved since the lookup.
  readonly branch: string
  readonly head: string
  readonly isBare: boolean
  readonly isArchived: boolean
}

// Both consumers treat unreadable metadata as no hint; normalize malformed baseRef/linkedPR to null before fallback.
const worktreeSummarySchema: z.ZodType<MobileWorktreeSummary | null, unknown> =
  worktreeSummaryReplySchema
    .transform((value): MobileWorktreeSummary | null =>
      value.worktree
        ? {
            baseRef: value.worktree.baseRef ?? null,
            linkedPR: value.worktree.linkedPR ?? null,
            suppressedGitHubPR: value.worktree.suppressedGitHubPR ?? null,
            pushTarget: value.worktree.pushTarget ?? null,
            branch: value.worktree.branch ?? '',
            head: value.worktree.head ?? '',
            isBare: value.worktree.isBare ?? false,
            isArchived: value.worktree.isArchived ?? false
          }
        : null
    )
    .catch(null)

// Refused metadata is a missing hint; callers try another source.
export const worktreeSummaryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.summary-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-summary', worktreeSummarySchema)
  })
)

export const worktreeLinkSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-review-link',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('link-accepted', z.unknown())
  })
)
