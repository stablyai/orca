import type { MobileWebTaskDetailComment } from '../../../src/shared/mobile-web/task-detail-contract'
import type { HostTaskItemMutationTarget } from './host-task-item-mutation-operations'
import type { HostTaskItemReviewOperations } from './host-task-item-review-operations'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskItemReviewOperations(
  client: RpcClient
): HostTaskItemReviewOperations {
  return {
    async addComment(target, body) {
      const response =
        target.provider === 'github'
          ? await client.sendRequest(
              'github.addIssueComment',
              {
                repo: `id:${target.repoId}`,
                number: target.number,
                body,
                type: target.type
              },
              { timeoutMs: 30_000 }
            )
          : await addGitLabComment(client, target, body)
      return mutationComment(response, 'Failed to add comment')
    },
    async requestReviewers(target, reviewers) {
      assertMutation(
        await client.sendRequest(
          'github.requestPRReviewers',
          {
            repo: `id:${target.repoId}`,
            prNumber: target.number,
            reviewers
          },
          { timeoutMs: 30_000 }
        ),
        'Failed to request reviewers'
      )
    },
    async resolveThread(target, threadId, resolve) {
      const response = await client.sendRequest(
        'github.resolveReviewThread',
        { repo: `id:${target.repoId}`, threadId, resolve },
        { timeoutMs: 30_000 }
      )
      if (!response.ok || response.result !== true) {
        throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
      }
    },
    async replyReviewComment(target, payload) {
      return mutationComment(
        await client.sendRequest(
          'github.addPRReviewCommentReply',
          {
            repo: `id:${target.repoId}`,
            prNumber: target.number,
            commentId: payload.commentId,
            body: payload.body,
            threadId: payload.threadId,
            path: payload.path,
            line: payload.line
          },
          { timeoutMs: 30_000 }
        ),
        'Failed to reply'
      )
    },
    async merge(target, method) {
      const response =
        target.provider === 'github'
          ? await client.sendRequest(
              'github.mergePR',
              { repo: `id:${target.repoId}`, prNumber: target.number, method },
              { timeoutMs: 60_000 }
            )
          : await client.sendRequest(
              'gitlab.mergeMR',
              {
                repo: `id:${target.repoId}`,
                iid: target.number,
                method,
                projectRef: target.projectRef
              },
              { timeoutMs: 60_000 }
            )
      assertMutation(response, 'Failed to merge review')
    }
  }
}

function addGitLabComment(
  client: RpcClient,
  target: Extract<HostTaskItemMutationTarget, { provider: 'gitlab' }>,
  body: string
) {
  return target.type === 'mr'
    ? client.sendRequest(
        'gitlab.addMRComment',
        {
          repo: `id:${target.repoId}`,
          iid: target.number,
          body,
          projectRef: target.projectRef
        },
        { timeoutMs: 30_000 }
      )
    : client.sendRequest(
        'gitlab.addIssueComment',
        {
          repo: `id:${target.repoId}`,
          number: target.number,
          body,
          projectRef: target.projectRef
        },
        { timeoutMs: 30_000 }
      )
}

function mutationComment(
  response: Awaited<ReturnType<RpcClient['sendRequest']>>,
  fallback: string
): MobileWebTaskDetailComment | undefined {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = response.result as {
    ok?: boolean
    error?: string
    comment?: MobileWebTaskDetailComment
  }
  if (result.ok === false) {
    throw new Error(result.error ?? fallback)
  }
  return result.comment
}

function assertMutation(
  response: Awaited<ReturnType<RpcClient['sendRequest']>>,
  fallback: string
): void {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = response.result as { ok?: boolean; error?: string }
  if (result.ok === false) {
    throw new Error(result.error ?? fallback)
  }
}
