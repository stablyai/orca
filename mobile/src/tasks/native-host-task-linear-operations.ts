import type { HostTaskLinearOperations } from './host-task-linear-operations'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskLinearOperations(client: RpcClient): HostTaskLinearOperations {
  return {
    async connect(apiKey) {
      assertMutation(
        await request(client, 'linear.connect', { apiKey }),
        'Failed to connect Linear'
      )
    },
    listTeams: () => request(client, 'linear.listTeams', undefined),
    teamStates: (target) =>
      request(client, 'linear.teamStates', {
        teamId: target.teamId,
        workspaceId: target.workspaceId
      }),
    async selectWorkspace(workspaceId) {
      assertMutation(
        await request(client, 'linear.selectWorkspace', { workspaceId }),
        'Failed to select workspace'
      )
    },
    async updateState(target, stateId) {
      assertMutation(
        await request(client, 'linear.updateIssue', {
          id: target.issueId,
          workspaceId: target.workspaceId,
          updates: { stateId }
        }),
        'Failed to update Linear issue'
      )
    },
    async addComment(target, body) {
      const result = await request<{ ok?: boolean; id?: string; error?: string }>(
        client,
        'linear.addIssueComment',
        { issueId: target.issueId, workspaceId: target.workspaceId, body }
      )
      assertMutation(result, 'Failed to add comment')
      return result.id
    },
    async loadIssue(target) {
      const issue = await request<Awaited<
        ReturnType<HostTaskLinearOperations['loadIssue']>
      > | null>(client, 'linear.getIssue', { id: target.issueId, workspaceId: target.workspaceId })
      if (!issue) {
        throw new Error('Linear issue not found')
      }
      return issue
    },
    async createSubIssue(target, title) {
      return createdIssue(
        await request(client, 'linear.createIssue', {
          teamId: target.teamId,
          title,
          workspaceId: target.workspaceId,
          parentIssueId: target.issueId,
          projectId: target.projectId ?? null
        })
      )
    },
    async createIssue(payload) {
      return createdIssue(
        await request(client, 'linear.createIssue', {
          teamId: payload.team.id,
          title: payload.title,
          description: payload.description,
          workspaceId: payload.team.workspaceId
        })
      )
    }
  }
}

async function request<T = unknown>(
  client: RpcClient,
  method: string,
  payload?: object
): Promise<T> {
  const response = await client.sendRequest(method, payload, { timeoutMs: 30_000 })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as T
}

function assertMutation(
  result: { ok?: boolean; error?: string } | undefined,
  fallback: string
): void {
  if (result?.ok === false) {
    throw new Error(result.error ?? fallback)
  }
}

function createdIssue(result: unknown) {
  const issue = result as {
    ok?: boolean
    id?: string
    identifier?: string
    title?: string
    url?: string
    error?: string
  }
  if (issue.ok === false || !issue.id || !issue.identifier) {
    throw new Error(issue.error ?? 'Failed to create Linear issue')
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.url ? { url: issue.url } : {})
  }
}
