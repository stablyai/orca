import type { DetailComment } from './mobile-tasks-provider-detail-types'
import type {
  HostTaskProjectItemTarget,
  HostTaskProjectMutationOperations
} from './host-task-project-mutation-operations'
import type { RpcRequestSender } from '../transport/rpc-client'

const PROJECT_PR_MUTATION_TIMEOUT_MS = 60_000
/** Every project mutation carried a connect deadline before this seam existed. Without one the
 *  transport parks the request through the whole reconnect backoff, roughly six minutes, with
 *  the row's mutation UI disabled and no error. */
const PROJECT_MUTATION_TIMEOUT_MS = 30_000

export function nativeHostTaskProjectMutationOperations(
  client: RpcRequestSender
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
      const result = await projectMutation<{ ok?: boolean; comment?: DetailComment }>(
        client,
        'github.project.addIssueCommentBySlug',
        { ...slugPayload(target), body },
        true
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
      const response = await client.sendRequest(
        'github.resolveReviewThread',
        {
          repo: `id:${repoId}`,
          prRepo: prRepoPayload(target),
          threadId,
          resolve
        },
        { timeoutMs: PROJECT_MUTATION_TIMEOUT_MS }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      if (response.result !== true) {
        throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
      }
    },
    async replyReviewComment(target, repoId, payload) {
      const result = await projectMutation<{ comment?: DetailComment }>(
        client,
        'github.addPRReviewCommentReply',
        {
          repo: `id:${repoId}`,
          prNumber: target.number,
          prRepo: prRepoPayload(target),
          ...payload
        }
      )
      return result.comment
    },
    async addConversationComment(target, repoId, body) {
      const result = await projectMutation<{ comment?: DetailComment }>(
        client,
        'github.addIssueComment',
        {
          repo: `id:${repoId}`,
          number: target.number,
          prRepo: prRepoPayload(target),
          body,
          type: target.type
        }
      )
      return result.comment
    },
    async requestReviewers(target, repoId, reviewers) {
      await projectMutation(client, 'github.requestPRReviewers', {
        repo: `id:${repoId}`,
        prNumber: target.number,
        prRepo: prRepoPayload(target),
        reviewers
      })
    },
    async rerunChecks(target, repoId, payload) {
      await projectMutation(
        client,
        'github.rerunPRChecks',
        {
          repo: `id:${repoId}`,
          prNumber: target.number,
          prRepo: prRepoPayload(target),
          ...payload
        },
        false,
        PROJECT_PR_MUTATION_TIMEOUT_MS
      )
    },
    async merge(target, repoId, method) {
      await projectMutation(
        client,
        'github.mergePR',
        {
          repo: `id:${repoId}`,
          prNumber: target.number,
          prRepo: prRepoPayload(target),
          method
        },
        false,
        PROJECT_PR_MUTATION_TIMEOUT_MS
      )
    }
  }
}

/** Fork/GHES decoration the host treats as optional. A row with no repository slug sent `null`
 *  before this seam existed, so refusing the whole call here would lose a working path. */
function prRepoPayload(target: HostTaskProjectItemTarget) {
  return target.owner && target.repo
    ? { owner: target.owner, repo: target.repo, host: target.host }
    : null
}

function slugPayload(target: HostTaskProjectItemTarget) {
  return {
    owner: target.owner,
    repo: target.repo,
    host: target.host,
    number: target.number
  }
}

/** The wording each caller reported for a refused mutation before these calls moved behind the
 *  seam. A host that refuses without a message must still name the action that failed. */
const PROJECT_MUTATION_FALLBACKS: Record<string, string> = {
  'github.project.updateIssueBySlug': 'Failed to update GitHub item',
  'github.project.updatePullRequestBySlug': 'Failed to update GitHub item',
  'github.project.addIssueCommentBySlug': 'Failed to add comment',
  'github.project.updateIssueCommentBySlug': 'Failed to edit comment',
  'github.project.deleteIssueCommentBySlug': 'Failed to delete comment',
  'github.project.updateItemField': 'Failed to update project field',
  'github.project.clearItemField': 'Failed to update project field',
  'github.project.updateIssueTypeBySlug': 'Failed to update issue type',
  'github.addPRReviewCommentReply': 'Failed to reply',
  'github.addIssueComment': 'Failed to reply',
  'github.requestPRReviewers': 'Failed to request reviewers',
  'github.rerunPRChecks': 'Failed to rerun checks',
  'github.mergePR': 'Failed to merge pull request'
}

async function projectMutation<T extends object = object>(
  client: RpcRequestSender,
  method: string,
  payload: object,
  requireOk = false,
  timeoutMs = PROJECT_MUTATION_TIMEOUT_MS
): Promise<T> {
  const fallback = PROJECT_MUTATION_FALLBACKS[method] ?? 'GitHub Project request failed'
  const response = await client.sendRequest(method, payload, { timeoutMs })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = response.result as { ok?: boolean; error?: string | { message?: string } }
  if (requireOk ? !result.ok : result.ok === false) {
    const error = result.error
    if (!method.startsWith('github.project.')) {
      throw new Error((error as string | undefined) ?? fallback)
    }
    const acceptsString =
      method === 'github.project.updateIssueCommentBySlug' ||
      method === 'github.project.deleteIssueCommentBySlug'
    throw new Error(
      acceptsString && typeof error === 'string'
        ? error
        : ((typeof error === 'object' ? error?.message : undefined) ?? fallback)
    )
  }
  return result as T
}
