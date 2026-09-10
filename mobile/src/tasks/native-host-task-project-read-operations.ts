import type { GitHubProjectViewSummary } from './github-project-reference'
import type {
  HostTaskProjectListResult,
  HostTaskProjectResolveResult
} from './host-task-project-payloads'
import type { GitHubProjectTable } from './mobile-tasks-view-state-types'
import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'
import { projectGitHubTaskDetail } from './github-task-detail-projection'
import type { RpcRequestSender } from '../transport/rpc-client'

export function nativeHostTaskProjectReadOperations(
  client: RpcRequestSender
): HostTaskProjectReadOperations {
  return {
    async listAccessible(host) {
      return projectResult<{
        projects: HostTaskProjectListResult['projects']
        partialFailures?: HostTaskProjectListResult['partialFailures']
      }>(client.sendRequest('github.project.listAccessible', { host })).then((result) => ({
        projects: result.projects,
        partialFailures: result.partialFailures ?? []
      }))
    },
    async listViews(project) {
      const result = await projectResult<{ views: GitHubProjectViewSummary[] }>(
        client.sendRequest('github.project.listViews', {
          owner: project.owner,
          host: project.host,
          ownerType: project.ownerType,
          projectNumber: project.number
        })
      )
      return result.views
    },
    async resolveRef(payload) {
      const result = await projectResult<HostTaskProjectResolveResult>(
        client.sendRequest('github.project.resolveRef', payload)
      )
      return {
        owner: result.owner,
        ownerType: result.ownerType,
        number: result.number,
        title: result.title,
        host: result.host,
        viewNumber: result.viewNumber
      }
    },
    async loadTable(payload) {
      const result = await projectResult<{ data: GitHubProjectTable }>(
        client.sendRequest(
          'github.project.viewTable',
          {
            owner: payload.owner,
            host: payload.host,
            ownerType: payload.ownerType,
            projectNumber: payload.number,
            viewId: payload.viewId,
            queryOverride: payload.queryOverride
          },
          { timeoutMs: 60_000 }
        )
      )
      return result.data
    },
    async loadItemDetail(payload) {
      const result = await projectResult<{ details: unknown }>(
        client.sendRequest('github.project.workItemDetailsBySlug', payload, { timeoutMs: 30_000 })
      )
      return projectGitHubTaskDetail(result.details)
    },
    async listItemLabels(payload) {
      const result = await projectResult<{ labels?: string[] }>(
        client.sendRequest('github.project.listLabelsBySlug', payload, { timeoutMs: 30_000 }),
        'Failed to load labels'
      )
      return result.labels ?? []
    },
    async listItemAssignableUsers(payload) {
      const result = await projectResult<{
        users?: Awaited<ReturnType<HostTaskProjectReadOperations['listItemAssignableUsers']>>
      }>(
        client.sendRequest('github.project.listAssignableUsersBySlug', payload, {
          timeoutMs: 30_000
        }),
        'Failed to load assignees'
      )
      return result.users ?? []
    },
    async listIssueTypes(payload) {
      const result = await projectResult<{
        types?: Awaited<ReturnType<HostTaskProjectReadOperations['listIssueTypes']>>
      }>(
        client.sendRequest('github.project.listIssueTypesBySlug', payload, {
          timeoutMs: 30_000
        }),
        'Failed to load issue types'
      )
      return result.types ?? []
    }
  }
}

/** `fallback` is the wording the calling screen reported before these reads moved behind the
 *  seam; a host that refuses without a message must still name what failed to load. */
export async function projectResult<T>(
  request: Promise<unknown>,
  fallback = 'GitHub Project request failed'
): Promise<T> {
  const response = (await request) as {
    ok: boolean
    result?: { ok?: boolean; error?: { message?: string } }
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(response.error?.message ?? fallback)
  }
  // main required an explicit ok:true; a result that omits the flag is not a confirmed success.
  if (!response.result?.ok) {
    throw new Error(response.result?.error?.message ?? fallback)
  }
  return response.result as T
}
