import type { RpcClient } from '../transport/rpc-client'
import type {
  HostSessionBrowserOperations,
  HostSessionBrowserTarget
} from './host-session-browser-operations'

export function nativeHostSessionBrowserOperations(
  client: RpcClient
): HostSessionBrowserOperations {
  return {
    async back(target) {
      await requestResult(client, 'browser.back', nativeTarget(target))
    },
    async forward(target) {
      await requestResult(client, 'browser.forward', nativeTarget(target))
    },
    async reload(target) {
      await requestResult(client, 'browser.reload', nativeTarget(target))
    }
  }
}

function nativeTarget(target: HostSessionBrowserTarget): { worktree: string; page: string } {
  return { worktree: `id:${target.workspaceId}`, page: target.pageId }
}

async function requestResult(client: RpcClient, method: string, payload: unknown): Promise<void> {
  const response = await client.sendRequest(method, payload, { timeoutMs: 15_000 })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
}
