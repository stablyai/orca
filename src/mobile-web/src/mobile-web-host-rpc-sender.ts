import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export type MobileWebHostRpcResponse =
  | { id: string; ok: true; result: unknown; _meta: { runtimeId: string } }
  | {
      id: string
      ok: false
      error: { code: string; message: string; data?: unknown }
      _meta: { runtimeId: string }
    }

export type MobileWebHostRpcSendOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export type MobileWebHostRpcSender = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: MobileWebHostRpcSendOptions
  ) => Promise<MobileWebHostRpcResponse>
}

const META = { runtimeId: 'hosted' }

function record(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {}
}

/** An `RpcClient.sendRequest` over the generic host lane, so page code written against the desktop
 * RPC runs unchanged inside the webview. Host-wide by construction: a workspace-scoped caller
 * passes its handle in `workspaceId`, and the shell rewrites it into the worktree selector. */
export function mobileWebHostRpcSender(
  requests: MobileWebOneShotRequestClient,
  workspaceId?: string
): MobileWebHostRpcSender {
  return {
    async sendRequest(method, params, options) {
      try {
        const result = await requestMobileWebHost(
          requests,
          method,
          workspaceId,
          record(params),
          options
        )
        return { id: method, ok: true, result, _meta: META }
      } catch (error) {
        const code = error instanceof MobileWebBridgeClientError ? error.code : 'internal'
        return {
          id: method,
          ok: false,
          error: { code, message: error instanceof Error ? error.message : code },
          _meta: META
        }
      }
    }
  }
}
