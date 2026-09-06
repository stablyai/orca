import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskProviderWriteOperations } from './host-task-provider-write-operations'

export function webHostTaskProviderWriteOperations(
  client: MobileWebBridgeClient
): HostTaskProviderWriteOperations {
  return {
    createIssue: (payload) => client.task.createProviderIssue(payload),
    async updateIssueSource(repoId, preference) {
      await client.task.updateIssueSource({ repoId, preference })
    }
  }
}
