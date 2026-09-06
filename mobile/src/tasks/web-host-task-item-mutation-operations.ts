import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  HostTaskItemMutationOperations,
  HostTaskItemMutationTarget
} from './host-task-item-mutation-operations'

export function webHostTaskItemMutationOperations(
  client: MobileWebBridgeClient
): HostTaskItemMutationOperations {
  return {
    async setClosed(target, closed) {
      await client.task.updateHostedTaskStatus({ targetId: targetId(target), closed })
    },
    async updateMetadata(target, updates) {
      await client.task.updateHostedTaskMetadata({ targetId: targetId(target), updates })
    }
  }
}

function targetId(target: HostTaskItemMutationTarget): string {
  if (!target.targetId) {
    throw new Error('Task mutation authority is unavailable')
  }
  return target.targetId
}
