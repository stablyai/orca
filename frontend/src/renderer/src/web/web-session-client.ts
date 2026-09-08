import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/runtime-rpc-envelope'
import {
  REQUEST_TIMEOUT_MS,
  isEndResult,
  isRuntimeFailureResponse,
  isSubscriptionResponse,
  type PendingRequest,
  type RuntimeSubscription,
  type SubscribeOptions,
  type SubscriptionCallbacks,
  type WebRuntimeSubscriptionHandle
} from './web-session-client-protocol'
import { WebSessionConnection } from './web-session-connection'

export type { SubscribeOptions, WebRuntimeSubscriptionHandle } from './web-session-client-protocol'

export class WebSessionClient {
  private readonly connection: WebSessionConnection
  private requestCounter = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, RuntimeSubscription>()

  constructor(endpoint: string) {
    this.connection = new WebSessionConnection(endpoint, {
      onMessage: (rawData) => this.handleSocketMessage(rawData),
      onConnectError: (message) => this.rejectAllPending(message),
      onAuthFailed: () => this.handleAuthFailed(),
      onInterrupted: () => this.handleInterrupted()
    })
  }

  async call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    await this.connection.waitForConnected(options?.timeoutMs)
    return new Promise((resolve, reject) => {
      const id = this.nextId()
      const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timeout })
      if (!this.connection.send({ id, authToken: 'cookie-auth', method, params })) {
        this.pending.delete(id)
        window.clearTimeout(timeout)
        reject(new Error('Remote Orca runtime is not connected.'))
      }
    })
  }

  async subscribe(
    method: string,
    params: unknown,
    callbacks: SubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    await this.connection.waitForConnected(options?.timeoutMs)
    const id = this.nextId()
    this.subscriptions.set(id, { method, params, callbacks })
    if (!this.connection.send({ id, authToken: 'cookie-auth', method, params })) {
      this.subscriptions.delete(id)
      throw new Error('Remote Orca runtime is not connected.')
    }
    return {
      unsubscribe: () => {
        this.subscriptions.delete(id)
        const teardown = options?.buildUnsubscribe?.(params)
        if (teardown) {
          this.connection.send({
            id: this.nextId(),
            authToken: 'cookie-auth',
            method: teardown.method,
            params: teardown.params
          })
        }
      },
      sendBinary: (_bytes) => {
        throw new Error('Binary frames not supported in session mode over this channel')
      }
    }
  }

  close(options: { notifySubscriptions?: boolean } = {}): void {
    const shouldNotifySubscriptions = options.notifySubscriptions ?? true
    this.rejectAllPending('Remote Orca runtime connection closed.')
    if (shouldNotifySubscriptions) {
      this.notifySubscriptionsClosed()
    } else {
      this.subscriptions.clear()
    }
    this.connection.close()
  }

  private handleSocketMessage(rawData: unknown): void {
    if (this.connection.getState() !== 'connected') {
      return
    }

    if (typeof rawData !== 'string') {
      return
    }

    let response: RuntimeRpcResponse<unknown> | Record<string, unknown>
    try {
      response = JSON.parse(rawData) as RuntimeRpcResponse<unknown> | Record<string, unknown>
    } catch {
      return
    }
    if (isKeepaliveFrame(response)) {
      return
    }
    if (!('id' in response) || typeof response.id !== 'string') {
      return
    }
    if (isRuntimeFailureResponse(response) && response.error.code === 'unauthorized') {
      this.connection.forceAuthFailed()
      this.handleAuthFailed()
      return
    }

    const subscription = this.subscriptions.get(response.id)
    if (subscription && isSubscriptionResponse(response)) {
      subscription.callbacks.onResponse(response)
      if (response.ok && isEndResult(response.result)) {
        this.subscriptions.delete(response.id)
        subscription.callbacks.onClose?.()
      }
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }
    this.pending.delete(response.id)
    window.clearTimeout(pending.timeout)
    pending.resolve(response as RuntimeRpcResponse<unknown>)
  }

  // Why: shared by both auth-failure detection paths — a close-code
  // (1008/3000/4401) relayed from WebSessionConnection, and an `unauthorized`
  // RPC error spotted inside a message — so the dispatch/reject/notify side
  // effects stay identical regardless of which path triggered them.
  private handleAuthFailed(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('orca:auth-failed'))
    }
    this.rejectAllPending('Unauthorized. Session cookie may have expired.')
    this.notifySubscriptionsError('unauthorized', 'Unauthorized. Session cookie may have expired.')
  }

  private handleInterrupted(): void {
    this.rejectAllPending('Remote Orca runtime connection interrupted.')
    this.notifySubscriptionsClosed()
  }

  private nextId(): string {
    this.requestCounter += 1
    return `web-session-rpc-${this.requestCounter}-${Date.now()}`
  }

  private rejectAllPending(reason: string): void {
    const error = new Error(reason)
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      window.clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }

  private notifySubscriptionsClosed(): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.subscriptions.clear()
    for (const subscription of subscriptions) {
      subscription.callbacks.onClose?.()
    }
  }

  private notifySubscriptionsError(code: string, message: string): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.subscriptions.clear()
    for (const subscription of subscriptions) {
      subscription.callbacks.onError?.({ code, message })
    }
  }
}
