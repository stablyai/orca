// Forwarded commands and results share the host-bound runtime subscription.
import {
  DesktopBrowserBridgeEvent,
  type DesktopBrowserBridgeRequest,
  type DesktopBrowserBridgeResultParams
} from '../../../shared/desktop-browser-bridge-protocol'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { DesktopBrowserBridgeOutcome } from './desktop-browser-bridge-executor'

const RESULT_TIMEOUT_MS = 30_000
// Keep browser errors within orcad's result-schema limits.
const MAX_ERROR_CODE_LENGTH = 128
const MAX_ERROR_MESSAGE_LENGTH = 4096

export type DesktopBrowserBridgeSubscribe = (callbacks: {
  onResponse(response: RuntimeRpcResponse<unknown>): void
  onError(error: Error): void
  onClose(): void
}) => Promise<RemoteRuntimeSubscription>

export class DesktopBrowserBridgeConnection {
  private subscription: RemoteRuntimeSubscription | null = null
  private attachmentId: string | null = null
  private closed = false
  private readonly revoked = new AbortController()
  private readonly cancellations = new Map<string, AbortController>()

  constructor(
    private readonly options: {
      subscribe: DesktopBrowserBridgeSubscribe
      /** hostRevoked ends the attachment; signal also covers per-command cancellation. */
      execute(
        request: DesktopBrowserBridgeRequest,
        signal: AbortSignal,
        hostRevoked: AbortSignal
      ): Promise<DesktopBrowserBridgeOutcome>
      onReady(): void
      /** Called once, when the attachment ends for any reason other than close(). */
      onLost(error: Error): void
    }
  ) {}

  get ready(): boolean {
    return this.attachmentId !== null && !this.closed
  }

  async start(): Promise<void> {
    let subscription: RemoteRuntimeSubscription
    try {
      subscription = await this.options.subscribe({
        onResponse: (response) => this.handleResponse(response),
        onError: (error) => this.lose(error),
        onClose: () => this.lose(new Error('desktop_browser_bridge_transport_closed'))
      })
    } catch (error) {
      this.lose(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (this.closed) {
      subscription.close()
      return
    }
    this.subscription = subscription
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.revoked.abort()
    this.attachmentId = null
    const subscription = this.subscription
    this.subscription = null
    subscription?.close()
  }

  private handleResponse(response: RuntimeRpcResponse<unknown>): void {
    if (this.closed) {
      return
    }
    if (!response.ok) {
      this.lose(new Error(`${response.error.code}: ${response.error.message}`))
      return
    }
    const parsed = DesktopBrowserBridgeEvent.safeParse(response.result)
    if (!parsed.success) {
      // A malformed event indicates an incompatible peer protocol.
      this.lose(new Error('desktop_browser_bridge_invalid_event'))
      return
    }
    if (parsed.data.type === 'ready') {
      if (this.attachmentId === null) {
        this.attachmentId = parsed.data.attachmentId
        this.options.onReady()
      }
      return
    }
    if (this.attachmentId === null) {
      this.lose(new Error('desktop_browser_bridge_request_before_ready'))
      return
    }
    if (parsed.data.type === 'cancel') {
      this.cancellations.get(parsed.data.requestId)?.abort()
      return
    }
    void this.answer(this.attachmentId, parsed.data)
  }

  private async answer(attachmentId: string, request: DesktopBrowserBridgeRequest): Promise<void> {
    // Cancel queued commands once orcad has stopped waiting.
    const cancelled = new AbortController()
    this.cancellations.set(request.requestId, cancelled)
    const signals = [this.revoked.signal, cancelled.signal]
    if (request.timeoutMs) {
      signals.push(AbortSignal.timeout(request.timeoutMs))
    }
    let outcome: DesktopBrowserBridgeOutcome
    try {
      outcome = await this.options.execute(request, AbortSignal.any(signals), this.revoked.signal)
    } finally {
      if (this.cancellations.get(request.requestId) === cancelled) {
        this.cancellations.delete(request.requestId)
      }
    }
    const sendRequest = this.subscription?.sendRequest
    if (this.closed || this.attachmentId !== attachmentId || !sendRequest) {
      return
    }
    const params: DesktopBrowserBridgeResultParams = outcome.ok
      ? { attachmentId, requestId: request.requestId, ok: true, result: outcome.result }
      : {
          attachmentId,
          requestId: request.requestId,
          ok: false,
          error: {
            code: outcome.error.code.slice(0, MAX_ERROR_CODE_LENGTH),
            message: outcome.error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
          }
        }
    if (await this.sendResult(sendRequest, params)) {
      return
    }
    // Report delivery failure now because the command already ran.
    await this.sendResult(sendRequest, {
      attachmentId,
      requestId: request.requestId,
      ok: false,
      error: {
        code: 'desktop_browser_bridge_result_undeliverable',
        message:
          'The desktop ran the command but could not send its result back (it may be too large, such as a full-page screenshot).'
      }
    })
  }

  /** False when result submission throws or the host refuses it. */
  private async sendResult(
    sendRequest: NonNullable<RemoteRuntimeSubscription['sendRequest']>,
    params: DesktopBrowserBridgeResultParams
  ): Promise<boolean> {
    try {
      const response = await sendRequest('desktopBrowserBridge.result', params, RESULT_TIMEOUT_MS)
      if (response.ok) {
        return true
      }
      console.warn(
        '[desktop-browser-bridge] The host refused a result:',
        `${response.error.code}: ${response.error.message}`
      )
    } catch (error) {
      console.warn(
        '[desktop-browser-bridge] Could not return a result to the host:',
        error instanceof Error ? error.message : String(error)
      )
    }
    return false
  }

  private lose(error: Error): void {
    if (this.closed) {
      return
    }
    this.close()
    this.options.onLost(error)
  }
}
