import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskListOperations } from './host-task-list-operations'

export function webHostTaskListOperations(client: MobileWebBridgeClient): HostTaskListOperations {
  return {
    listGitHub: (payload) => client.task.listGitHub(payload),
    async countGitHub(payload) {
      return (await client.task.countGitHub(payload)).count
    },
    listGitLab: (payload) => client.task.listGitLab(payload),
    async listGitLabTodos(repoId) {
      return (await client.task.listGitLabTodos({ repoId })).items
    },
    async listLinear(payload) {
      return (await client.task.listLinear(payload)).items
    }
  }
}
