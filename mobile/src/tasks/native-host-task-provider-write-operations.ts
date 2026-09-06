import type { HostTaskProviderWriteOperations } from './host-task-provider-write-operations'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskProviderWriteOperations(
  client: RpcClient
): HostTaskProviderWriteOperations {
  return {
    async createIssue(payload) {
      const response = await client.sendRequest(
        payload.provider === 'github' ? 'github.createIssue' : 'gitlab.createIssue',
        {
          repo: `id:${payload.repoId}`,
          title: payload.title,
          body: payload.body
        }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = response.result as {
        ok?: boolean
        number?: number
        url?: string
        error?: string
      }
      if (result.ok === false) {
        throw new Error(result.error ?? `Failed to create ${payload.provider} issue`)
      }
      return {
        ...(typeof result.number === 'number' ? { number: result.number } : {}),
        ...(result.url ? { url: result.url } : {})
      }
    },
    async updateIssueSource(repoId, preference) {
      const response = await client.sendRequest(
        'repo.update',
        {
          repo: `id:${repoId}`,
          updates: { issueSourcePreference: preference }
        },
        { timeoutMs: 15_000 }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    }
  }
}
