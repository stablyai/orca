import type { HostTaskItemFileOperations } from './host-task-item-file-operations'
import type { RpcRequestSender } from '../transport/rpc-client'

export function nativeHostTaskItemFileOperations(
  client: RpcRequestSender
): HostTaskItemFileOperations {
  return {
    async refreshChecks(target, headSha) {
      const checks = await request(client, 'github.prChecks', {
        ...repoPayload(target),
        prNumber: target.number,
        headSha,
        noCache: true
      })
      if (!Array.isArray(checks)) {
        throw new Error('Invalid checks response')
      }
      return checks
    },
    async rerunChecks(target, headSha, failedOnly) {
      const result = await request<{ ok?: boolean; error?: string }>(
        client,
        'github.rerunPRChecks',
        {
          ...repoPayload(target),
          prNumber: target.number,
          headSha,
          failedOnly
        },
        60_000
      )
      if (result.ok === false) {
        throw new Error(result.error ?? 'Failed to rerun checks')
      }
    },
    async setFileViewed(target, payload) {
      const result = await request(client, 'github.setPRFileViewed', {
        ...repoPayload(target),
        ...payload
      })
      if (result !== true) {
        throw new Error('Failed to sync viewed state with GitHub.')
      }
    },
    loadFileContents(target, payload) {
      return request(client, 'github.prFileContents', {
        ...repoPayload(target),
        prNumber: target.number,
        ...payload
      })
    },
    async addInlineComment(target, payload) {
      const result = await request<{
        ok?: boolean
        error?: string
        comment?: Awaited<ReturnType<HostTaskItemFileOperations['addInlineComment']>>
      }>(client, 'github.addPRReviewComment', {
        ...repoPayload(target),
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

function repoPayload(target: { repoId: string }) {
  return { repo: `id:${target.repoId}` }
}

async function request<T = unknown>(
  client: RpcRequestSender,
  method: string,
  payload: object,
  timeoutMs = 30_000
): Promise<T> {
  const response = await client.sendRequest(method, payload, { timeoutMs })
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task request failed')
  }
  return response.result as T
}
