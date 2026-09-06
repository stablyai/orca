import { extractLinearIssueReadItems } from './linear-mobile-issue-read'
import type { HostTaskListOperations } from './host-task-list-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

export function nativeHostTaskListOperations(client: RpcClient): HostTaskListOperations {
  return {
    async listGitHub(payload) {
      return successfulResult(
        client.sendRequest(
          'github.listWorkItems',
          {
            repo: `id:${payload.repoId}`,
            limit: payload.limit,
            query: payload.query,
            before: payload.before
          },
          { timeoutMs: 30_000 }
        )
      )
    },
    async countGitHub(payload) {
      const result = await successfulResult<unknown>(
        client.sendRequest(
          'github.countWorkItems',
          { repo: `id:${payload.repoId}`, query: payload.query },
          { timeoutMs: 30_000 }
        )
      )
      return typeof result === 'number' ? result : 0
    },
    listGitLab(payload) {
      return successfulResult(
        client.sendRequest('gitlab.listWorkItems', {
          repo: `id:${payload.repoId}`,
          state: payload.state,
          page: payload.page,
          perPage: payload.perPage,
          query: payload.query
        })
      )
    },
    async listGitLabTodos(repoId) {
      // An empty todo list comes back as null from older hosts; the seam promises an array.
      const todos = await successfulResult(
        client.sendRequest('gitlab.todos', { repo: `id:${repoId}` })
      )
      return Array.isArray(todos) ? todos : []
    },
    async listLinear(payload) {
      const response = payload.query
        ? client.sendRequest('linear.searchIssues', {
            query: payload.query,
            limit: payload.limit,
            workspaceId: payload.workspaceId
          })
        : client.sendRequest('linear.listIssues', {
            filter: payload.filter,
            limit: payload.limit,
            workspaceId: payload.workspaceId
          })
      return extractLinearIssueReadItems(await successfulResult(response))
    }
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
