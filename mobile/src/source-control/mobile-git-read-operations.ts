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

// Changes keeps the host payload; the normalized reader drops rows/nulls malformed status and would alter its display.
export const gitStatusHostPayloadRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.status-host-payload',
    method: 'git.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-status-payload', gitStatusHostPayloadSchema)
  })
)

// Unreadable projected status remains null for callers’ fallback paths.
export const gitStatusProjectionReader: RpcCompatibleReader<
  unknown,
  'normalized-status',
  MobileGitStatusResult | null
> = rpcResultVariant('normalized-status', gitStatusProjectionSchema)

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

export const gitCommitCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.commit-compare-entries',
    method: 'git.commitCompare',
    acceptance: 'require-result-or-throw-message',
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
