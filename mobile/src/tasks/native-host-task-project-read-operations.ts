import type {
  MobileWebTaskProjectListResult,
  MobileWebTaskProjectResolveResult,
  MobileWebTaskProjectView
} from '../../../src/shared/mobile-web/task-project-read-contract'
import type { MobileWebTaskProjectTable } from '../../../src/shared/mobile-web/task-project-table-contract'
import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'
import { projectGitHubTaskDetail } from './github-task-detail-projection'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskProjectReadOperations(
  client: RpcClient
): HostTaskProjectReadOperations {
  return {
    async listAccessible(host) {
      return projectResult<{
        projects: MobileWebTaskProjectListResult['projects']
        partialFailures?: MobileWebTaskProjectListResult['partialFailures']
      }>(client.sendRequest('github.project.listAccessible', { host })).then((result) => ({
        projects: result.projects,
        partialFailures: result.partialFailures ?? []
      }))
    },
    async listViews(project) {
      const result = await projectResult<{ views: MobileWebTaskProjectView[] }>(
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
      const result = await projectResult<MobileWebTaskProjectResolveResult>(
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
      const result = await projectResult<{ data: MobileWebTaskProjectTable }>(
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
        client.sendRequest('github.project.listLabelsBySlug', payload, { timeoutMs: 30_000 })
      )
      return result.labels ?? []
    },
    async listItemAssignableUsers(payload) {
      const result = await projectResult<{
        users?: Awaited<ReturnType<HostTaskProjectReadOperations['listItemAssignableUsers']>>
      }>(
        client.sendRequest('github.project.listAssignableUsersBySlug', payload, {
          timeoutMs: 30_000
        })
      )
      return result.users ?? []
    },
    async listIssueTypes(payload) {
      const result = await projectResult<{
        types?: Awaited<ReturnType<HostTaskProjectReadOperations['listIssueTypes']>>
      }>(
        client.sendRequest('github.project.listIssueTypesBySlug', payload, {
          timeoutMs: 30_000
        })
      )
      return result.types ?? []
    }
  }
}

async function projectResult<T>(request: Promise<unknown>): Promise<T> {
  const response = (await request) as {
    ok: boolean
    result?: { ok?: boolean; error?: { message?: string } }
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'GitHub Project request failed')
  }
  if (response.result?.ok === false) {
    throw new Error(response.result.error?.message ?? 'GitHub Project request failed')
  }
  return response.result as T
}
