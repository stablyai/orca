import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebTaskItemFileOperation } from './mobile-web-task-item-file-operations'
import { executeMobileWebTaskItemMutationOperation } from './mobile-web-task-item-mutation-operations'
import { executeMobileWebTaskItemReviewOperation } from './mobile-web-task-item-review-operations'
import { executeMobileWebTaskLinearOperation } from './mobile-web-task-linear-operations'
import { executeMobileWebTaskProjectFileOperation } from './mobile-web-task-project-file-operation-execution'
import { executeMobileWebTaskProjectMutationOperation } from './mobile-web-task-project-mutation-operations'
import { executeMobileWebTaskProviderWriteOperation } from './mobile-web-task-provider-write-operations'
import type { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type OperationResult = { handled: boolean; result?: unknown }

export async function executeMobileWebTaskWriteOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<OperationResult> {
  const executors = [
    executeMobileWebTaskItemFileOperation,
    executeMobileWebTaskItemMutationOperation,
    executeMobileWebTaskItemReviewOperation,
    executeMobileWebTaskLinearOperation,
    executeMobileWebTaskProjectMutationOperation,
    executeMobileWebTaskProjectFileOperation,
    executeMobileWebTaskProviderWriteOperation
  ]
  for (const execute of executors) {
    const result = await execute({
      operation: args.operation,
      payload: args.payload,
      client: args.client,
      targetAuthority: args.targetAuthority,
      workspaceAuthority: args.workspaceAuthority
    })
    if (result.handled) {
      return result
    }
  }
  return { handled: false }
}
