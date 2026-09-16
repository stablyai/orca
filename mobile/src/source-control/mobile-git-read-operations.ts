import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import {
  rpcUncheckedMemberReader,
  rpcUncheckedPayloadReader
} from '../transport/rpc-reader-payload'
import { readMobileGitStatusResult } from '../session/mobile-diff-review-rpc'
import type { MobileGitStatusResult } from './mobile-git-status'

// Source-control reads. Every one of these replies used to be re-typed with a cast at the call
// site; the reader below is now the only place that says what the payload is.

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
    read: rpcUncheckedPayloadReader('host-status-payload')
  })
)

/** Shared with the session's branch-context read, which wants the same projection under a skip. */
export const gitStatusProjectionReader: RpcCompatibleReader<
  unknown,
  'normalized-status',
  MobileGitStatusResult | null
> = (raw) => ({
  compatible: true,
  variant: 'normalized-status',
  value: readMobileGitStatusResult(raw),
  salvage: { droppedPaths: [], droppedCount: 0 }
})

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
    read: rpcUncheckedPayloadReader('history-page')
  })
)

/**
 * A refused compare leaves the row's file list untouched, so refusal is a skip, not a throw. The
 * member read keeps the property-read exception a null result throws, which is what leaves an
 * already-loaded file list alone.
 */
export const gitCommitCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.commit-compare-entries-or-skip',
    method: 'git.commitCompare',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedMemberReader('commit-compare-entries', 'entries')
  })
)

export const gitBranchCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-compare',
    method: 'git.branchCompare',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('branch-compare')
  })
)

export const gitBranchDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-diff',
    method: 'git.branchDiff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('branch-diff')
  })
)
