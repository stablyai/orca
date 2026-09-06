import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskDetailOperations } from './host-task-detail-operations'

export function webHostTaskDetailOperations(
  client: MobileWebBridgeClient
): HostTaskDetailOperations {
  return {
    async listGitHubLabels(repoId) {
      return (await client.task.listGitHubLabels({ repoId })).labels
    },
    async listGitHubAssignableUsers(repoId) {
      return (await client.task.listGitHubAssignableUsers({ repoId })).users
    },
    loadGitHub: (payload) => client.task.loadGitHubDetail(payload),
    loadGitLab(payload) {
      if (!payload.targetId) {
        throw new Error('Task target is unavailable')
      }
      return client.task.loadGitLabDetail({ targetId: payload.targetId })
    },
    loadLinear(payload) {
      if (!payload.targetId) {
        throw new Error('Linear task target is unavailable')
      }
      return client.task.loadLinearDetail({ targetId: payload.targetId })
    }
  }
}
