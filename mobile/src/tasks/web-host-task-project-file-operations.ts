import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskProjectFileOperations } from './host-task-project-file-operations'
import type { HostTaskProjectItemTarget } from './host-task-project-mutation-operations'

export function webHostTaskProjectFileOperations(
  client: MobileWebBridgeClient
): HostTaskProjectFileOperations {
  return {
    async refreshChecks(target, repoId, headSha) {
      return (
        await client.task.refreshProjectChecks({
          targetId: targetId(target),
          repoId,
          ...(headSha ? { headSha } : {})
        })
      ).checks
    },
    async setFileViewed(target, repoId, payload) {
      await client.task.setProjectFileViewed({ targetId: targetId(target), repoId, ...payload })
    },
    loadFileContents: (target, repoId, payload) =>
      client.task.loadProjectFileContents({ targetId: targetId(target), repoId, ...payload }),
    async addInlineComment(target, repoId, payload) {
      return (
        await client.task.addProjectInlineComment({
          targetId: targetId(target),
          repoId,
          ...payload
        })
      ).comment
    }
  }
}

function targetId(target: HostTaskProjectItemTarget): string {
  if (!target.targetId) {
    throw new Error('Project mutation authority is unavailable')
  }
  return target.targetId
}
