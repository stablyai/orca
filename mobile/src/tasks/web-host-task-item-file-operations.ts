import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskGitHubItemTarget } from './host-task-item-mutation-operations'
import type { HostTaskItemFileOperations } from './host-task-item-file-operations'

export function webHostTaskItemFileOperations(
  client: MobileWebBridgeClient
): HostTaskItemFileOperations {
  return {
    async refreshChecks(target) {
      return (await client.task.refreshHostedTaskChecks({ targetId: targetId(target) })).checks
    },
    async rerunChecks(target, _headSha, failedOnly) {
      await client.task.rerunHostedTaskChecks({ targetId: targetId(target), failedOnly })
    },
    async setFileViewed(target, payload) {
      await client.task.setHostedTaskFileViewed({
        targetId: targetId(target),
        path: payload.path,
        viewed: payload.viewed
      })
    },
    loadFileContents: (target, payload) =>
      client.task.loadHostedTaskFileContents({
        targetId: targetId(target),
        path: payload.path
      }),
    async addInlineComment(target, payload) {
      return (
        await client.task.addHostedTaskInlineComment({
          targetId: targetId(target),
          path: payload.path,
          line: payload.line,
          body: payload.body
        })
      ).comment
    }
  }
}

function targetId(target: HostTaskGitHubItemTarget): string {
  if (!target.targetId) {
    throw new Error('Task file authority is unavailable')
  }
  return target.targetId
}
