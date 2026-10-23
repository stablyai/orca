import { BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR } from '../../shared/browser-client-file-channel-methods'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

/** Only unsupported legacy hosts permit local saves; unavailable channels must refuse transfers. */
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

/** Keep executor transport stable while authority changes replace the host lease. */
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
