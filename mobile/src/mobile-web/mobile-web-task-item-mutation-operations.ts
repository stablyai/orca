import {
  MobileWebTaskItemMetadataPayloadSchema,
  MobileWebTaskItemMutationResultSchema,
  MobileWebTaskItemStatusPayloadSchema
} from '../../../src/shared/mobile-web/task-item-mutation-contract'
import { nativeHostTaskDetailOperations } from '../tasks/native-host-task-detail-operations'
import { nativeHostTaskItemMutationOperations } from '../tasks/native-host-task-item-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'
import type {
  MobileWebHostedTaskTarget,
  MobileWebTaskTargetAuthority
} from './mobile-web-task-target-authority'

const OPERATIONS = new Set(['updateHostedTaskStatus', 'updateHostedTaskMetadata'])

export async function executeMobileWebTaskItemMutationOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const targetId =
    args.operation === 'updateHostedTaskStatus'
      ? MobileWebTaskItemStatusPayloadSchema.parse(args.payload).targetId
      : MobileWebTaskItemMetadataPayloadSchema.parse(args.payload).targetId
  const target = args.targetAuthority.resolveHosted(targetId)
  await revalidateHostedTask(args.client, target)
  args.targetAuthority.assertHostedTarget(targetId, target)
  const operations = nativeHostTaskItemMutationOperations(args.client)
  if (args.operation === 'updateHostedTaskStatus') {
    const payload = MobileWebTaskItemStatusPayloadSchema.parse(args.payload)
    await operations.setClosed(target, payload.closed)
  } else {
    const payload = MobileWebTaskItemMetadataPayloadSchema.parse(args.payload)
    await operations.updateMetadata(target, payload.updates)
  }
  return { handled: true, result: MobileWebTaskItemMutationResultSchema.parse(null) }
}

async function revalidateHostedTask(
  client: RpcClient,
  target: MobileWebHostedTaskTarget
): Promise<void> {
  const details = nativeHostTaskDetailOperations(client)
  if (target.provider === 'github') {
    await details.loadGitHub(target)
    return
  }
  await details.loadGitLab(target)
}
