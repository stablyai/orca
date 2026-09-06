import type {
  MobileWebTaskDetailComment,
  MobileWebTaskGitLabDetailResult
} from '../../../src/shared/mobile-web/task-detail-contract'
import type { MobileWebTaskLinearIssue } from '../../../src/shared/mobile-web/task-list-contract'
import type { HostTaskDetailOperations } from './host-task-detail-operations'
import { projectGitHubTaskDetail } from './github-task-detail-projection'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

type GitLabRawDetails = Partial<MobileWebTaskGitLabDetailResult> & {
  item?: {
    labels?: string[]
    mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  }
}

export function nativeHostTaskDetailOperations(client: RpcClient): HostTaskDetailOperations {
  return {
    async listGitHubLabels(repoId) {
      return successfulResult(
        client.sendRequest('github.listLabels', { repo: `id:${repoId}` }, { timeoutMs: 30_000 })
      )
    },
    async listGitHubAssignableUsers(repoId) {
      return successfulResult(
        client.sendRequest(
          'github.listAssignableUsers',
          { repo: `id:${repoId}` },
          { timeoutMs: 30_000 }
        )
      )
    },
    async loadGitHub(payload) {
      const details = await successfulResult<unknown>(
        client.sendRequest(
          'github.workItemDetails',
          {
            repo: `id:${payload.repoId}`,
            number: payload.number,
            type: payload.type
          },
          { timeoutMs: 30_000 }
        )
      )
      return projectGitHubTaskDetail(details)
    },
    async loadGitLab(payload) {
      const details = await successfulResult<GitLabRawDetails | null>(
        client.sendRequest(
          'gitlab.workItemDetails',
          {
            repo: `id:${payload.repoId}`,
            iid: payload.number,
            type: payload.type,
            projectRef: payload.projectRef
          },
          { timeoutMs: 30_000 }
        )
      )
      if (!details) {
        throw new Error('Details not found')
      }
      return {
        body: details.body ?? '',
        comments: details.comments ?? [],
        labels: details.item?.labels ?? details.labels,
        assignees: details.assignees ?? [],
        pipelineJobs: details.pipelineJobs ?? [],
        ...(details.item?.mergeable ? { item: { mergeable: details.item.mergeable } } : {}),
        ...(details.reviewers ? { reviewers: details.reviewers } : {}),
        ...(details.approvalState ? { approvalState: details.approvalState } : {})
      }
    },
    async loadLinear(payload) {
      const [issue, comments] = await Promise.all([
        successfulResult<MobileWebTaskLinearIssue | null>(
          client.sendRequest(
            'linear.getIssue',
            { id: payload.issueId, workspaceId: payload.workspaceId },
            { timeoutMs: 30_000 }
          )
        ),
        optionalComments(
          client.sendRequest(
            'linear.issueComments',
            { issueId: payload.issueId, workspaceId: payload.workspaceId },
            { timeoutMs: 30_000 }
          )
        )
      ])
      if (!issue) {
        throw new Error('Details not found')
      }
      return { issue, comments }
    }
  }
}

async function optionalComments(request: Promise<unknown>): Promise<MobileWebTaskDetailComment[]> {
  try {
    return await successfulResult(request)
  } catch {
    return []
  }
}

async function successfulResult<T>(request: Promise<unknown>): Promise<T> {
  const response = (await request) as {
    ok: boolean
    result?: unknown
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task provider request failed')
  }
  return (response as RpcSuccess).result as T
}
