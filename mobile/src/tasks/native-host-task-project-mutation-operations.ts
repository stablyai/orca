import type { MobileWebTaskDetailComment } from '../../../src/shared/mobile-web/task-detail-contract'
import type {
  HostTaskProjectItemTarget,
  HostTaskProjectMutationOperations
} from './host-task-project-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'
import {
  fetchAddIssueComment,
  fetchAddPRReviewCommentReply,
  fetchMergePR,
  fetchRequestPRReviewers,
  fetchRerunPRChecks,
  fetchResolveReviewThread,
  type GitHubPrMutationOutcome
} from '../session/github-pr-mutations'

const PROJECT_PR_MUTATION_TIMEOUT_MS = 60_000

export function nativeHostTaskProjectMutationOperations(
  client: RpcClient
): HostTaskProjectMutationOperations {
  return {
    async updateItem(target, updates) {
      await projectMutation(
        client,
        target.type === 'issue'
          ? 'github.project.updateIssueBySlug'
          : 'github.project.updatePullRequestBySlug',
        { ...slugPayload(target), updates }
      )
    },
    async addComment(target, body) {
      const result = await projectMutation<{ comment?: MobileWebTaskDetailComment }>(
        client,
        'github.project.addIssueCommentBySlug',
        { ...slugPayload(target), body }
      )
      return result.comment
    },
    async updateComment(target, commentId, body) {
      await projectMutation(client, 'github.project.updateIssueCommentBySlug', {
        owner: target.owner,
        repo: target.repo,
        host: target.host,
        commentId,
        body
      })
    },
    async deleteComment(target, commentId) {
      await projectMutation(client, 'github.project.deleteIssueCommentBySlug', {
        owner: target.owner,
        repo: target.repo,
        host: target.host,
        commentId
      })
    },
    async updateMetadata(target, updates) {
      await projectMutation(client, 'github.project.updateIssueBySlug', {
        ...slugPayload(target),
        updates
      })
    },
    async updateField(target, fieldId, value) {
      await projectMutation(
        client,
        value === null ? 'github.project.clearItemField' : 'github.project.updateItemField',
        value === null
          ? { projectId: target.projectId, host: target.host, itemId: target.itemId, fieldId }
          : {
              projectId: target.projectId,
              host: target.host,
              itemId: target.itemId,
              fieldId,
              value
            }
      )
    },
    async updateIssueType(target, issueTypeId) {
      await projectMutation(client, 'github.project.updateIssueTypeBySlug', {
        ...slugPayload(target),
        issueTypeId
      })
    },
    async resolveReviewThread(target, repoId, threadId, resolve) {
      requirePrMutation(
        await fetchResolveReviewThread(client, repoId, {
          threadId,
          resolve,
          // Why: `prRepo` is fork/GHES decoration the host treats as optional, and a draft row
          // has no slug — send it only when one resolved rather than an empty pair.
          prRepo: target.owner && target.repo ? slugPayload(target) : null
        })
      )
    },
    async replyReviewComment(target, repoId, payload) {
      return prMutationComment(
        await fetchAddPRReviewCommentReply(client, repoId, {
          prNumber: target.number,
          ...payload,
          prRepo: slugPayload(target)
        })
      )
    },
    async addConversationComment(target, repoId, body) {
      return prMutationComment(
        await fetchAddIssueComment(client, repoId, {
          prNumber: target.number,
          body,
          prRepo: slugPayload(target),
          type: target.type
        })
      )
    },
    async requestReviewers(target, repoId, reviewers) {
      requirePrMutation(
        await fetchRequestPRReviewers(client, repoId, {
          prNumber: target.number,
          reviewers,
          prRepo: slugPayload(target)
        })
      )
    },
    async rerunChecks(target, repoId, payload) {
      requirePrMutation(
        await fetchRerunPRChecks(
          client,
          repoId,
          { prNumber: target.number, ...payload, prRepo: slugPayload(target) },
          // A CI rerun and a merge both routinely outrun the 30s default.
          { timeoutMs: PROJECT_PR_MUTATION_TIMEOUT_MS }
        )
      )
    },
    async merge(target, repoId, method) {
      requirePrMutation(
        await fetchMergePR(
          client,
          repoId,
          { prNumber: target.number, method, prRepo: slugPayload(target) },
          { timeoutMs: PROJECT_PR_MUTATION_TIMEOUT_MS }
        )
      )
    }
  }
}

function slugPayload(target: HostTaskProjectItemTarget) {
  return {
    owner: target.owner,
    repo: target.repo,
    host: target.host,
    number: target.number
  }
}

async function projectMutation<T extends object = object>(
  client: RpcClient,
  method: string,
  payload: object
): Promise<T> {
  const response = (await client.sendRequest(method, payload, { timeoutMs: 30_000 })) as {
    ok: boolean
    result?: { ok?: boolean; error?: string | { message?: string } }
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'GitHub Project request failed')
  }
  if (response.result?.ok === false) {
    const error = response.result.error
    throw new Error(
      typeof error === 'string' ? error : (error?.message ?? 'GitHub Project request failed')
    )
  }
  return (response.result ?? {}) as T
}

function requirePrMutation(result: GitHubPrMutationOutcome): void {
  if (!result.ok) {
    throw new Error(result.error)
  }
}

function prMutationComment(
  result: GitHubPrMutationOutcome
): MobileWebTaskDetailComment | undefined {
  requirePrMutation(result)
  return (result as { comment?: MobileWebTaskDetailComment }).comment
}
