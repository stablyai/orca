import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  gitBranchCompareResultSchema,
  gitCommitCompareResultSchema,
  gitDiffResultSchema
} from './git-compare-reply-schema'
import { gitHistoryResultSchema } from './git-history-reply-schema'
import { gitStatusHostPayloadSchema, gitStatusProjectionSchema } from './git-status-reply-schema'
import type { MobileGitStatusResult } from './mobile-git-status'

// Source-control reads. Every reply below is validated against the members its consumer actually
// reads; the schema module beside each one records which consumer line justifies each requirement.

/**
 * git.status, first of two readers. The Changes screen publishes the host payload verbatim.
 *
 * Justification for a second reader on one method: hosted-review preparation has always read the
 * normalized projection instead, and the projection is not a superset — it returns null when
 * `entries` is not an array and drops entries missing a path or area. Those are replies the
 * Changes screen renders today, so sharing the projecting reader would change what it shows.
 * Unifying the two is a product decision with its own expectation, not part of this migration.
 */
export const gitStatusHostPayloadRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.status-host-payload',
    method: 'git.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-status-payload', gitStatusHostPayloadSchema)
  })
)

/**
 * Shared with the session's branch-context read, which wants the same projection under a skip.
 *
 * Still always compatible: the projection's own contract is that an unreadable payload is a null
 * status, which three screens route on.
 */
export const gitStatusProjectionReader: RpcCompatibleReader<
  unknown,
  'normalized-status',
  MobileGitStatusResult | null
> = rpcResultVariant('normalized-status', gitStatusProjectionSchema)

/** git.status, second reader: the normalized projection hosted-review preparation reads. */
export const gitStatusProjectionRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.status-normalized',
    method: 'git.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: gitStatusProjectionReader
  })
)

export const gitHistoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.history-page',
    method: 'git.history',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('history-page', gitHistoryResultSchema)
  })
)

/**
 * A refused compare leaves the row's file list untouched, so refusal is a skip, not a throw. A
 * reply that carries no readable `entries` is now an incompatible reply rather than an undefined
 * list: the row's `.catch` resolves it to "No file changes" instead of spinning forever.
 */
export const gitCommitCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.commit-compare-entries-or-skip',
    method: 'git.commitCompare',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('commit-compare', gitCommitCompareResultSchema)
  })
)

export const gitBranchCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-compare',
    method: 'git.branchCompare',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('branch-compare', gitBranchCompareResultSchema)
  })
)

export const gitBranchDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-diff',
    method: 'git.branchDiff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('branch-diff', gitDiffResultSchema)
  })
)
