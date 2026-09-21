import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { openRpcRequestBudget, resolvePostConnectRequestTimeout } from './rpc-request-budget'
import type { SendRequestOptions } from './rpc-client'
import type { ConnectionState, RpcResponse } from './types'

const REQUEST_TIMEOUT_MS = 30_000

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type RequestTrackerOptions = {
  nextId: () => string
  getState: () => ConnectionState
  waitForConnected: (timeoutMs?: number) => Promise<void>
  sendEncrypted: (request: unknown) => boolean
  deviceToken: string
}

export class RpcClientRequestTracker {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: RequestTrackerOptions) {}

  async sendRequest(
    method: string,
    params?: unknown,
    requestOptions?: SendRequestOptions
  ): Promise<RpcResponse> {
    const budget = openRpcRequestBudget(requestOptions)
    const waitStart = budget.startedAt
    const wasConnected = this.options.getState() === 'connected'
    if (requestOptions?.failWhenDisconnected && !wasConnected) {
      throw new Error(`Not connected: ${method}`)
    }
    await this.options.waitForConnected(requestOptions?.timeoutMs)
    if (!wasConnected) {
      console.log('[net] sendRequest waited for connect', {
        method,
        waitedMs: Date.now() - waitStart
      })
    }

    return this.sendConnectedRequest(
      method,
      params,
      resolvePostConnectRequestTimeout(budget, REQUEST_TIMEOUT_MS)
    )
  }

  sendAuthenticatedRequest(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<RpcResponse> {
    return this.sendConnectedRequest(method, params, timeoutMs)
  }

  private sendConnectedRequest(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const id = this.options.nextId()
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        console.log('[net] sendRequest TIMEOUT', {
          method,
          timeoutMs,
          state: this.options.getState()
        })
        reject(markRpcDeliveryUnknown(new Error(`Request timed out: ${method}`)))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      if (
        !this.options.sendEncrypted({
          id,
          deviceToken: this.options.deviceToken,
          method,
          params
        })
      ) {
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(new Error('Connection interrupted'))
      }
    })
  }

  resolve(response: RpcResponse): boolean {
    const request = this.pending.get(response.id)
    if (!request) {
      return false
    }
    this.pending.delete(response.id)
    request.resolve(response)
    return true
  }

  rejectAll(reason: string, options?: { deliveryUnknown?: boolean }): void {
    const error = options?.deliveryUnknown
      ? markRpcDeliveryUnknown(new Error(reason))
      : new Error(reason)
    for (const [id, request] of this.pending) {
      this.pending.delete(id)
      queueMicrotask(() => request.reject(error))
    }
  }

  size(): number {
    return this.pending.size
  }
}
