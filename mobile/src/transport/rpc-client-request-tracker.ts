import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { openRpcRequestBudget, resolvePostConnectRequestTimeout } from './rpc-request-budget'
import type { SendRequestOptions } from './rpc-client'
import type { RpcEnvelopeFields, RpcRequestFrame } from './rpc-envelope-fields'
import type { ConnectionState, RpcResponse } from './types'
import { startRpcRequestDeadline, type RpcRequestDeadline } from './rpc-request-keepalive'

const REQUEST_TIMEOUT_MS = 30_000

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  deadline: RpcRequestDeadline
}

type RequestTrackerOptions = {
  nextId: () => string
  getState: () => ConnectionState
  waitForConnected: (timeoutMs?: number) => Promise<void>
  sendFrame: (frame: RpcRequestFrame) => boolean
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
      resolvePostConnectRequestTimeout(budget, REQUEST_TIMEOUT_MS),
      requestOptions?.envelope,
      requestOptions?.keepaliveTotalMs
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
    timeoutMs: number,
    envelope?: RpcEnvelopeFields,
    keepaliveTotalMs?: number
  ): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const id = this.options.nextId()
      const deadline = startRpcRequestDeadline(timeoutMs, keepaliveTotalMs, () => {
        this.pending.delete(id)
        console.log('[net] sendRequest TIMEOUT', {
          method,
          timeoutMs,
          state: this.options.getState()
        })
        reject(markRpcDeliveryUnknown(new Error(`Request timed out: ${method}`)))
      })
      this.pending.set(id, {
        resolve: (response) => {
          deadline.clear()
          resolve(response)
        },
        reject: (error) => {
          deadline.clear()
          reject(error)
        },
        deadline
      })
      if (!this.options.sendFrame({ id, method, params, envelope })) {
        this.pending.delete(id)
        deadline.clear()
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

  /** A retired or unknown request's keepalive renews nothing. */
  keepalive(requestId: string): void {
    this.pending.get(requestId)?.deadline.renew()
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
