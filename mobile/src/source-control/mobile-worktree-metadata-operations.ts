import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

export type MobileWorktreeSummary = {
  readonly baseRef: string | null
  readonly linkedPR: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One reader for both worktree.show consumers. Branch compare read `worktree.baseRef` behind an
 * `isRecord` guard and the PR sidebar read `worktree.linkedPR` through optional chaining; both
 * yield null on the same inputs, so the fields merge without changing either answer.
 */
const worktreeSummaryReader: RpcCompatibleReader<
  unknown,
  'worktree-summary',
  MobileWorktreeSummary | null
> = (raw) => {
  const worktree = isRecord(raw) ? raw.worktree : undefined

  return {
    compatible: true,
    variant: 'worktree-summary',
    value: isRecord(worktree)
      ? {
          baseRef: typeof worktree.baseRef === 'string' ? worktree.baseRef : null,
          linkedPR: typeof worktree.linkedPR === 'number' ? worktree.linkedPR : null
        }
      : null,
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

/** A refused show is a missing hint, not a failure: both callers fall back to another source. */
export const worktreeSummaryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.summary-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: worktreeSummaryReader
  })
)

/** Persisting a review link. The payload is unread; only acceptance matters. */
export const worktreeLinkSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-review-link',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('link-accepted')
  })
)
