import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  HostTaskProjectItemTarget,
  HostTaskProjectMutationOperations
} from './host-task-project-mutation-operations'

export function webHostTaskProjectMutationOperations(
  client: MobileWebBridgeClient
): HostTaskProjectMutationOperations {
  return {
    async updateItem(target, updates) {
      await client.task.updateProjectItem({ targetId: targetId(target), updates })
    },
    async addComment(target, body) {
      return (await client.task.addProjectComment({ targetId: targetId(target), body })).comment
    },
    async updateComment(target, commentId, body) {
      await client.task.updateProjectComment({
        targetId: targetId(target),
        commentId,
        body
      })
    },
    async deleteComment(target, commentId) {
      await client.task.deleteProjectComment({ targetId: targetId(target), commentId })
    },
    async updateMetadata(target, updates) {
      await client.task.updateProjectMetadata({ targetId: targetId(target), updates })
    },
    async updateField(target, fieldId, value) {
      await client.task.updateProjectField({ targetId: targetId(target), fieldId, value })
    },
    async updateIssueType(target, issueTypeId) {
      await client.task.updateProjectIssueType({
        targetId: targetId(target),
        issueTypeId
      })
    },
    async resolveReviewThread(target, repoId, threadId, resolve) {
      await client.task.resolveProjectReviewThread({
        targetId: targetId(target),
        repoId,
        threadId,
        resolve
      })
    },
    // The hosted bridge publishes no comment on these; callers fall back to a local entry.
    async replyReviewComment(target, repoId, payload) {
      await client.task.replyProjectReviewComment({
        targetId: targetId(target),
        repoId,
        ...payload
      })
      return undefined
    },
    async addConversationComment(target, repoId, body) {
      await client.task.addProjectConversationComment({
        targetId: targetId(target),
        repoId,
        body
      })
      return undefined
    },
    async requestReviewers(target, repoId, reviewers) {
      await client.task.requestProjectReviewers({
        targetId: targetId(target),
        repoId,
        reviewers
      })
    },
    async rerunChecks(target, repoId, payload) {
      await client.task.rerunProjectChecks({
        targetId: targetId(target),
        repoId,
        ...payload
      })
    },
    async merge(target, repoId, method) {
      await client.task.mergeProjectPullRequest({
        targetId: targetId(target),
        repoId,
        method
      })
    }
  }
}

function targetId(target: HostTaskProjectItemTarget): string {
  if (!target.targetId) {
    throw new Error('Project mutation authority is unavailable')
  }
  return target.targetId
}
