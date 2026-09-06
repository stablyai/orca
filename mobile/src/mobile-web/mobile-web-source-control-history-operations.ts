import {
  MobileWebSourceControlBranchesPayloadSchema,
  MobileWebSourceControlCommitComparePayloadSchema,
  MobileWebSourceControlHistoryPayloadSchema,
  type MobileWebSourceControlBranchCompareResult,
  type MobileWebSourceControlBranchesResult,
  type MobileWebSourceControlCommitCompareResult,
  type MobileWebSourceControlHistoryResult
} from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import {
  sanitizeMobileWebBranches,
  sanitizeMobileWebCommitCompare,
  sanitizeMobileWebHistory
} from './mobile-web-source-control-history-sanitizers'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import type { MobileWebSourceControlBranchComparePager } from './mobile-web-source-control-branch-compare-pager'

type HistoryOperation = 'branches' | 'history' | 'branchCompare' | 'commitCompare'
type HistoryOperationResult =
  | MobileWebSourceControlBranchesResult
  | MobileWebSourceControlHistoryResult
  | MobileWebSourceControlBranchCompareResult
  | MobileWebSourceControlCommitCompareResult

export function isMobileWebSourceControlHistoryOperation(
  operation: string
): operation is HistoryOperation {
  return (
    operation === 'branches' ||
    operation === 'history' ||
    operation === 'branchCompare' ||
    operation === 'commitCompare'
  )
}

export async function executeMobileWebSourceControlHistoryOperation(args: {
  operation: HistoryOperation
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  branchComparePager?: MobileWebSourceControlBranchComparePager
  requestId?: string
}): Promise<HistoryOperationResult> {
  if (args.operation === 'branches') {
    const payload = MobileWebSourceControlBranchesPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('git.localBranches', {
      worktree: `id:${hostWorkspaceId}`
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeMobileWebBranches(response.result, payload.workspaceId)
  }
  if (args.operation === 'history') {
    const payload = MobileWebSourceControlHistoryPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('git.history', {
      worktree: `id:${hostWorkspaceId}`,
      limit: payload.limit,
      ...(payload.baseRef ? { baseRef: payload.baseRef } : {})
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeMobileWebHistory(response.result, payload.workspaceId, payload.limit)
  }
  if (args.operation === 'branchCompare') {
    if (!args.branchComparePager) {
      throw new MobileWebBrokerError('internal')
    }
    return args.branchComparePager.page(
      args.payload,
      args.client,
      args.workspaceAuthority,
      args.requestId
    )
  }

  const payload = MobileWebSourceControlCommitComparePayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const response = await args.client.sendRequest('git.commitCompare', {
    worktree: `id:${hostWorkspaceId}`,
    commitId: payload.commitId
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return sanitizeMobileWebCommitCompare(response.result, payload.workspaceId, payload.commitId)
}
