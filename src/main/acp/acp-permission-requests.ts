import { AcpRpcError } from './acp-errors'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import {
  RequestPermissionResponseSchema,
  type RequestPermissionRequest,
  type RequestPermissionResponse
} from './generated/protocol.gen'

export type AcpPermissionHandler = (
  request: RequestPermissionRequest,
  context: AcpRequestContext
) => RequestPermissionResponse | Promise<RequestPermissionResponse>

const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
type OpenPermission = { sessionId: string; cancel: () => void }

export class AcpPermissionRequests {
  private readonly open = new Set<OpenPermission>()

  cancel(sessionId: string): void {
    for (const permission of this.open) {
      if (permission.sessionId === sessionId) {
        permission.cancel()
      }
    }
  }

  handle(
    request: RequestPermissionRequest,
    context: AcpRequestContext,
    handler: AcpPermissionHandler | undefined
  ): Promise<RequestPermissionResponse> {
    if (!handler || context.signal.aborted) {
      return Promise.resolve(cancelled)
    }
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      const finish = (response: RequestPermissionResponse | Error): void => {
        if (settled) {
          return
        }
        settled = true
        this.open.delete(permission)
        context.signal.removeEventListener('abort', permission.cancel)
        controller.abort()
        if (response instanceof Error) {
          reject(response)
        } else {
          resolve(response)
        }
      }
      const permission: OpenPermission = {
        sessionId: request.sessionId,
        cancel: () => finish(cancelled)
      }
      this.open.add(permission)
      context.signal.addEventListener('abort', permission.cancel, { once: true })
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) {
            return cancelled
          }
          return handler(request, { id: context.id, signal: controller.signal })
        })
        .then((response) => {
          if (settled) {
            return
          }
          const parsed = RequestPermissionResponseSchema.safeParse(response)
          if (!parsed.success) {
            finish(new AcpRpcError(-32603, 'Invalid permission handler response'))
            return
          }
          const outcome = parsed.data.outcome
          if (
            outcome.outcome === 'selected' &&
            !request.options.some((option) => option.optionId === outcome.optionId)
          ) {
            finish(new AcpRpcError(-32603, 'Permission handler selected an unavailable option'))
            return
          }
          finish(parsed.data)
        })
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
    })
  }
}
