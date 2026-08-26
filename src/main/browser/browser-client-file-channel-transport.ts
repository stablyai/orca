import { BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR } from '../../shared/browser-client-file-channel-methods'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

/**
 * `unsupported` is the mixed-version case — the lease attached to a host that never offered the file
 * channel — and is the only one that may fall back to the desktop Downloads folder. `unavailable`
 * (no lease yet, transport lost, host closed) must fail closed instead: the host may well support
 * the channel, so a local save would be a silent downgrade of where the bytes land.
 */
export type BrowserClientFileChannelAvailability = 'negotiated' | 'unsupported' | 'unavailable'

export type BrowserClientFileChannelSender = {
  readonly fileChannelNegotiated: boolean
  readonly fileChannelAvailability: BrowserClientFileChannelAvailability
  sendFileChannelRequest(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<unknown>>
}

export const BROWSER_CLIENT_FILE_CHANNEL_REQUEST_TIMEOUT_MS = 30_000

/**
 * Indirection between the page command executor and the browser-host lease that carries file-channel
 * requests. The lease is replaced on authority transitions, so the executor holds this instead.
 */
export class BrowserClientFileChannelTransport {
  private sender: BrowserClientFileChannelSender | null = null

  bind(sender: BrowserClientFileChannelSender): void {
    this.sender = sender
  }

  unbind(sender: BrowserClientFileChannelSender): void {
    if (this.sender === sender) {
      this.sender = null
    }
  }

  get available(): boolean {
    return this.sender?.fileChannelNegotiated === true
  }

  get availability(): BrowserClientFileChannelAvailability {
    if (this.available) {
      return 'negotiated'
    }
    return this.sender?.fileChannelAvailability ?? 'unavailable'
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs = BROWSER_CLIENT_FILE_CHANNEL_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const sender = this.sender
    if (!sender?.fileChannelNegotiated) {
      throw new Error(BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR)
    }
    const response = await sender.sendFileChannelRequest(method, params, timeoutMs)
    if (!response.ok) {
      throw new RemoteRuntimeClientError(response.error.code, response.error.message)
    }
    return response.result
  }
}
