import type { MobileWebSourceControlCommitResult } from '../../../src/shared/mobile-web/source-control-commit-contract'
import type {
  MobileWebSourceControlBranchCompareResult,
  MobileWebSourceControlBranchesResult,
  MobileWebSourceControlCommitCompareResult,
  MobileWebSourceControlHistoryResult
} from '../../../src/shared/mobile-web/source-control-history-contract'
import {
  MobileWebSourceControlDiscardPayloadSchema,
  MobileWebSourceControlMutationResultSchema,
  MobileWebSourceControlStagePayloadSchema,
  MobileWebSourceControlUnstagePayloadSchema,
  type MobileWebSourceControlDiscardPayload,
  type MobileWebSourceControlMutationOperation,
  type MobileWebSourceControlMutationResult,
  type MobileWebSourceControlStagePayload,
  type MobileWebSourceControlUnstagePayload
} from '../../../src/shared/mobile-web/source-control-mutation-contract'
import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlStatusPayloadSchema,
  type MobileWebSourceControlDiffResult,
  type MobileWebSourceControlStatusResult
} from '../../../src/shared/mobile-web/source-control-operation-contract'
import type {
  MobileWebSourceControlRepositoryState,
  MobileWebSourceControlSyncResult
} from '../../../src/shared/mobile-web/source-control-sync-contract'
import type {
  MobileWebSourceControlReviewDiffResult,
  MobileWebSourceControlReviewLinkResult,
  MobileWebSourceControlReviewMetadataResult,
  MobileWebSourceControlReviewTerminalSendResult
} from '../../../src/shared/mobile-web/source-control-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { executeMobileWebSourceControlCommit } from './mobile-web-source-control-commit-operation'
import {
  executeMobileWebSourceControlHistoryOperation,
  isMobileWebSourceControlHistoryOperation
} from './mobile-web-source-control-history-operations'
import { assertMobileWebSourceControlMutationPreflight } from './mobile-web-source-control-mutation-preflight'
import {
  sanitizeMobileWebSourceControlDiff,
  sanitizeMobileWebSourceControlStatus
} from './mobile-web-source-control-read-results'
import {
  executeMobileWebSourceControlSyncOperation,
  isMobileWebSourceControlSyncOperation
} from './mobile-web-source-control-sync-operations'
import {
  executeMobileWebSourceControlReviewOperation,
  isMobileWebSourceControlReviewOperation
} from './mobile-web-source-control-review-operations'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import type { MobileWebSourceControlBranchComparePager } from './mobile-web-source-control-branch-compare-pager'

export async function executeMobileWebSourceControlOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  branchComparePager?: MobileWebSourceControlBranchComparePager
  requestId?: string
  terminalClientId?: string
}): Promise<
  | MobileWebSourceControlStatusResult
  | MobileWebSourceControlDiffResult
  | MobileWebSourceControlMutationResult
  | MobileWebSourceControlCommitResult
  | MobileWebSourceControlBranchesResult
  | MobileWebSourceControlHistoryResult
  | MobileWebSourceControlBranchCompareResult
  | MobileWebSourceControlCommitCompareResult
  | MobileWebSourceControlRepositoryState
  | MobileWebSourceControlSyncResult
  | MobileWebSourceControlReviewMetadataResult
  | MobileWebSourceControlReviewLinkResult
  | MobileWebSourceControlReviewDiffResult
  | MobileWebSourceControlReviewTerminalSendResult
  | null
> {
  if (isMobileWebSourceControlReviewOperation(args.operation)) {
    return executeMobileWebSourceControlReviewOperation(args)
  }
  if (isMobileWebSourceControlSyncOperation(args.operation)) {
    return executeMobileWebSourceControlSyncOperation({
      operation: args.operation,
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (isMobileWebSourceControlHistoryOperation(args.operation)) {
    return executeMobileWebSourceControlHistoryOperation({
      operation: args.operation,
      payload: args.payload,
      client: args.client,
      workspaceAuthority: args.workspaceAuthority,
      branchComparePager: args.branchComparePager,
      requestId: args.requestId
    })
  }
  if (args.operation === 'status') {
    const payload = MobileWebSourceControlStatusPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('git.status', {
      worktree: `id:${hostWorkspaceId}`,
      reuseLineStats: true
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeMobileWebSourceControlStatus(response.result, payload.workspaceId, payload.limit)
  }
  if (args.operation === 'diff') {
    const payload = MobileWebSourceControlDiffPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('git.diff', {
      worktree: `id:${hostWorkspaceId}`,
      filePath: payload.relativePath,
      staged: payload.area === 'staged'
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeMobileWebSourceControlDiff(response.result, payload)
  }
  if (args.operation === 'stage' || args.operation === 'unstage' || args.operation === 'discard') {
    return executeMutation(args.operation, args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'commit') {
    return executeMobileWebSourceControlCommit(args.payload, args.client, args.workspaceAuthority)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function executeMutation(
  operation: MobileWebSourceControlMutationOperation,
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebSourceControlMutationResult> {
  const payload = parseMutationPayload(operation, input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const preflight = await client.sendRequest('git.status', {
    worktree: `id:${hostWorkspaceId}`,
    reuseLineStats: true
  })
  if (!preflight.ok) {
    throw mobileWebBrokerHostRpcError(preflight.error)
  }
  assertMobileWebSourceControlMutationPreflight({
    result: preflight.result,
    expectedHead: payload.expectedHead,
    entries: payload.entries
  })
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)

  const relativePaths = payload.entries.map((entry) => entry.relativePath)
  const bulk = relativePaths.length > 1
  const method = mutationRpcMethod(operation, bulk)
  const response = await client.sendRequest(method, {
    worktree: `id:${hostWorkspaceId}`,
    ...(bulk ? { filePaths: relativePaths } : { filePath: relativePaths[0] })
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return MobileWebSourceControlMutationResultSchema.parse({
    workspaceId: payload.workspaceId,
    operation,
    relativePaths,
    mutated: true
  })
}

function parseMutationPayload(
  operation: MobileWebSourceControlMutationOperation,
  input: unknown
):
  | MobileWebSourceControlStagePayload
  | MobileWebSourceControlUnstagePayload
  | MobileWebSourceControlDiscardPayload {
  if (operation === 'stage') {
    return MobileWebSourceControlStagePayloadSchema.parse(input)
  }
  if (operation === 'unstage') {
    return MobileWebSourceControlUnstagePayloadSchema.parse(input)
  }
  return MobileWebSourceControlDiscardPayloadSchema.parse(input)
}

function mutationRpcMethod(
  operation: MobileWebSourceControlMutationOperation,
  bulk: boolean
):
  | 'git.stage'
  | 'git.bulkStage'
  | 'git.unstage'
  | 'git.bulkUnstage'
  | 'git.discard'
  | 'git.bulkDiscard' {
  if (operation === 'stage') {
    return bulk ? 'git.bulkStage' : 'git.stage'
  }
  if (operation === 'unstage') {
    return bulk ? 'git.bulkUnstage' : 'git.unstage'
  }
  return bulk ? 'git.bulkDiscard' : 'git.discard'
}
