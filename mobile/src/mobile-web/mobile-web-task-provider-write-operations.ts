import {
  MobileWebTaskIssueSourcePayloadSchema,
  MobileWebTaskProviderIssueCreatePayloadSchema,
  MobileWebTaskProviderIssueCreateResultSchema,
  MobileWebTaskProviderMutationResultSchema
} from '../../../src/shared/mobile-web/task-provider-write-contract'
import { nativeHostTaskProviderWriteOperations } from '../tasks/native-host-task-provider-write-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const OPERATIONS = new Set(['createProviderIssue', 'updateIssueSource'])

export async function executeMobileWebTaskProviderWriteOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const operations = nativeHostTaskProviderWriteOperations(args.client)
  if (args.operation === 'createProviderIssue') {
    const payload = MobileWebTaskProviderIssueCreatePayloadSchema.parse(args.payload)
    return {
      handled: true,
      result: MobileWebTaskProviderIssueCreateResultSchema.parse(
        await operations.createIssue({
          ...payload,
          repoId: args.workspaceAuthority.hostRepoId(payload.repoId)
        })
      )
    }
  }
  const payload = MobileWebTaskIssueSourcePayloadSchema.parse(args.payload)
  await operations.updateIssueSource(
    args.workspaceAuthority.hostRepoId(payload.repoId),
    payload.preference
  )
  return {
    handled: true,
    result: MobileWebTaskProviderMutationResultSchema.parse(null)
  }
}
