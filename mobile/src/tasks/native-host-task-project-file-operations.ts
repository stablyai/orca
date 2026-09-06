import type { HostTaskProjectFileOperations } from './host-task-project-file-operations'
import type { HostTaskProjectItemTarget } from './host-task-project-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskProjectFileOperations(
  client: RpcClient
): HostTaskProjectFileOperations {
  return {
    async refreshChecks(target, repoId, headSha) {
      const checks = await request(client, 'github.prChecks', {
        ...repoPayload(target, repoId),
        prNumber: target.number,
        headSha,
        noCache: true
      })
      if (!Array.isArray(checks)) {
        throw new Error('Invalid checks response')
      }
      return checks
    },
    async setFileViewed(target, repoId, payload) {
      const result = await request(client, 'github.setPRFileViewed', {
        ...repoPayload(target, repoId),
        ...payload
      })
      if (result !== true) {
        throw new Error('Failed to sync viewed state with GitHub.')
      }
    },
    loadFileContents(target, repoId, payload) {
      return request(client, 'github.prFileContents', {
        ...repoPayload(target, repoId),
        prNumber: target.number,
        ...payload
      })
    },
    async addInlineComment(target, repoId, payload) {
      const result = await request<{
        ok?: boolean
        error?: string
        comment?: Awaited<ReturnType<HostTaskProjectFileOperations['addInlineComment']>>
      }>(client, 'github.addPRReviewComment', {
        ...repoPayload(target, repoId),
        prNumber: target.number,
        ...payload
      })
      if (result.ok === false) {
        throw new Error(result.error ?? 'Failed to add review comment')
      }
      return result.comment
    }
  }
}

function repoPayload(target: HostTaskProjectItemTarget, repoId: string) {
  return {
    repo: `id:${repoId}`,
    prRepo: { owner: target.owner, repo: target.repo, host: target.host }
  }
}

async function request<T = unknown>(
  client: RpcClient,
  method: string,
  payload: object
): Promise<T> {
  const response = await client.sendRequest(method, payload, { timeoutMs: 30_000 })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as T
}
