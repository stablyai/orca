import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostTaskItemMutationTarget } from './host-task-item-mutation-operations'
import type { HostTaskItemReviewOperations } from './host-task-item-review-operations'

export function webHostTaskItemReviewOperations(
  client: MobileWebBridgeClient
): HostTaskItemReviewOperations {
  return {
    async addComment(target, body) {
      return (await client.task.addHostedTaskComment({ targetId: targetId(target), body })).comment
    },
    async requestReviewers(target, reviewers) {
      await client.task.requestHostedTaskReviewers({
        targetId: targetId(target),
        reviewers
      })
    },
    async resolveThread(target, threadId, resolve) {
      await client.task.resolveHostedTaskReviewThread({
        targetId: targetId(target),
        threadId,
        resolve
      })
    },
    async replyReviewComment(target, payload) {
      // The hosted bridge publishes no comment on reply; callers fall back to a local entry.
      await client.task.replyHostedTaskReviewComment({
        targetId: targetId(target),
        ...payload
      })
      return undefined
    },
    async merge(target, method) {
      await client.task.mergeHostedTaskReview({ targetId: targetId(target), method })
    }
  }
}

function targetId(target: HostTaskItemMutationTarget): string {
  if (!target.targetId) {
    throw new Error('Task review authority is unavailable')
  }
  return target.targetId
}
