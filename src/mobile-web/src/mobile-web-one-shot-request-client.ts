import type { z } from 'zod'
import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  type MobileWebBridgeCapability,
  type MobileWebBridgeOperationName,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { tolerantMobileWebShellPayload } from '../../shared/mobile-web/shell-payload-tolerance'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { encodedMobileWebBridgeValueByteLength } from './mobile-web-bridge-request-encoding'
import {
  MOBILE_WEB_BRIDGE_REQUEST_TIMEOUT_MS,
  type MobileWebBridgeRequestOptions,
  type MobileWebBridgePendingRequest
} from './mobile-web-bridge-request-state'

type OperationGrant = Extract<MobileWebBridgeShellMessage, { type: 'init' }>['grants'][number]

export class MobileWebOneShotRequestClient {
  private readonly pending = new Map<string, MobileWebBridgePendingRequest>()
  private disposed = false

  constructor(
    private readonly options: {
      getGrant: (
        capability: MobileWebBridgeCapability,
        operation: MobileWebBridgeOperationName
      ) => OperationGrant | undefined
      postMessage: (message: MobileWebBridgePageMessage) => boolean
      envelope: () => Pick<MobileWebBridgePageMessage, 'version' | 'shellSessionId' | 'buildId'>
      createRequestId: () => string
      otherPendingCount: () => number
      requestTimeoutMs?: number
    }
  ) {}

  request<TCapability extends MobileWebBridgeCapability, TPayload, TResult>(
    capability: TCapability,
    operation: MobileWebBridgeOperationName<TCapability>,
    payload: TPayload,
    payloadSchema: z.ZodType<TPayload>,
    resultSchema: z.ZodType<TResult>,
    options: MobileWebBridgeRequestOptions = {}
  ): Promise<TResult> {
    if (this.disposed || options.signal?.aborted) {
      return Promise.reject(new MobileWebBridgeClientError('cancelled', false))
    }
    const grant = this.options.getGrant(capability, operation)
    if (!grant) {
      return Promise.reject(new MobileWebBridgeClientError('unsupported_capability', false))
    }
    const parsedPayload = payloadSchema.safeParse(payload)
    if (!parsedPayload.success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    if (encodedMobileWebBridgeValueByteLength(parsedPayload.data) > grant.limits.maxRequestBytes) {
      return Promise.reject(new MobileWebBridgeClientError('too_large', false))
    }
    if (
      this.pending.size + this.options.otherPendingCount() >=
      MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS
    ) {
      return Promise.reject(new MobileWebBridgeClientError('rate_limited', true))
    }
    let requestId: string
    try {
      requestId = this.options.createRequestId()
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const pending = this.pending.get(requestId)
          if (!pending) {
            return
          }
          this.releasePending(requestId, pending)
          this.postCancel(requestId)
          reject(new MobileWebBridgeClientError('timeout', true))
        },
        options.timeoutMs ?? this.options.requestTimeoutMs ?? MOBILE_WEB_BRIDGE_REQUEST_TIMEOUT_MS
      )
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as TResult),
        reject,
        resultSchema,
        timer
      })
      const posted = this.options.postMessage({
        ...this.options.envelope(),
        type: 'request',
        mode: 'once',
        requestId,
        capability,
        operation,
        payload: parsedPayload.data
      })
      if (!posted) {
        this.finishWithError(requestId, new MobileWebBridgeClientError('unavailable', true))
        return
      }
      if (options.signal?.aborted) {
        this.cancelRequest(requestId)
        return
      }
      if (options.signal) {
        const cancel = () => this.cancelRequest(requestId)
        options.signal.addEventListener('abort', cancel, { once: true })
        const pending = this.pending.get(requestId)
        if (pending) {
          pending.removeAbortListener = () => options.signal?.removeEventListener('abort', cancel)
        }
      }
    })
  }

  receive(message: MobileWebBridgeShellMessage): boolean {
    if (this.disposed || message.type !== 'response') {
      return false
    }
    const pending = this.pending.get(message.requestId)
    if (!pending) {
      return false
    }
    if (message.status === 'error') {
      this.finishWithError(
        message.requestId,
        new MobileWebBridgeClientError(message.error.code, message.error.retryable)
      )
      return true
    }
    // Shell->page: tolerate a newer shell's additive result rather than failing unretryably.
    const parsed = tolerantMobileWebShellPayload(pending.resultSchema).safeParse(message.payload)
    if (!parsed.success) {
      this.finishWithError(
        message.requestId,
        new MobileWebBridgeClientError('invalid_message', false)
      )
      return true
    }
    this.releasePending(message.requestId, pending)
    pending.resolve(parsed.data)
    return true
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const [requestId, pending] of this.pending) {
      this.releasePending(requestId, pending)
      this.postCancel(requestId)
      pending.reject(new MobileWebBridgeClientError('cancelled', false))
    }
  }

  hasMessageId(id: string): boolean {
    return this.pending.has(id)
  }

  pendingCount(): number {
    return this.pending.size
  }

  private finishWithError(requestId: string, error: MobileWebBridgeClientError): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.releasePending(requestId, pending)
    pending.reject(error)
  }

  private cancelRequest(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.releasePending(requestId, pending)
    this.postCancel(requestId)
    pending.reject(new MobileWebBridgeClientError('cancelled', false))
  }

  private releasePending(requestId: string, pending: MobileWebBridgePendingRequest): void {
    clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    this.pending.delete(requestId)
  }

  private postCancel(requestId: string): void {
    this.options.postMessage({
      ...this.options.envelope(),
      type: 'cancel',
      target: 'request',
      id: requestId
    })
  }
}
